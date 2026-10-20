use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{ipc::Channel, State, Window};
use tokio::sync::{oneshot, Notify};

use crate::bonsai_events::SseDecoder;

const EVENTS_URL: &str = "http://localhost:8080/bonsai/events";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum BonsaiStreamEvent {
    Connected,
    Message { data: String },
    Error { message: String },
}

struct StreamControl {
    owner: String,
    _cancel: oneshot::Sender<()>,
    acknowledged: Arc<Notify>,
    on_event: Channel<BonsaiStreamEvent>,
}

#[derive(Default)]
struct Streams {
    next_id: u32,
    active: HashMap<u32, StreamControl>,
}

#[derive(Clone, Default)]
pub(crate) struct BonsaiEventStreams(Arc<Mutex<Streams>>);

impl BonsaiEventStreams {
    pub(crate) fn cancel_window(&self, owner: &str) {
        if let Ok(mut streams) = self.0.lock() {
            streams.active.retain(|_, stream| stream.owner != owner);
        }
    }
}

#[tauri::command]
pub(crate) fn subscribe_bonsai_events(
    on_event: Channel<BonsaiStreamEvent>,
    window: Window,
    streams: State<'_, BonsaiEventStreams>,
) -> Result<u32, String> {
    let (cancel, cancelled) = oneshot::channel();
    let acknowledged = Arc::new(Notify::new());
    let stream_id = {
        let mut registry = streams
            .inner()
            .0
            .lock()
            .map_err(|error| error.to_string())?;
        registry.next_id = registry
            .next_id
            .checked_add(1)
            .ok_or("Bonsai stream identifier exhausted")?;
        let stream_id = registry.next_id;
        // A window monitors one machine. Replacement also cleans up after reload.
        registry.active.retain(|_, stream| {
            if stream.owner != window.label() {
                return true;
            }
            let _ = stream.on_event.send(BonsaiStreamEvent::Error {
                message: "Bonsai event subscription replaced".to_string(),
            });
            false
        });
        registry.active.insert(
            stream_id,
            StreamControl {
                owner: window.label().to_string(),
                _cancel: cancel,
                acknowledged: acknowledged.clone(),
                on_event: on_event.clone(),
            },
        );
        stream_id
    };

    let streams = streams.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = stream_events(&on_event, cancelled, acknowledged).await;
        let active = streams
            .0
            .lock()
            .map(|mut registry| registry.active.remove(&stream_id).is_some())
            .unwrap_or(false);
        if active {
            if let Err(message) = result {
                let _ = on_event.send(BonsaiStreamEvent::Error { message });
            }
        }
    });
    Ok(stream_id)
}

#[tauri::command]
pub(crate) fn ack_bonsai_events(
    stream_id: u32,
    window: Window,
    streams: State<'_, BonsaiEventStreams>,
) -> Result<(), String> {
    let registry = streams
        .inner()
        .0
        .lock()
        .map_err(|error| error.to_string())?;
    if let Some(stream) = registry.active.get(&stream_id) {
        if stream.owner == window.label() {
            stream.acknowledged.notify_one();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_bonsai_events(
    stream_id: u32,
    window: Window,
    streams: State<'_, BonsaiEventStreams>,
) -> Result<(), String> {
    let mut registry = streams
        .inner()
        .0
        .lock()
        .map_err(|error| error.to_string())?;
    if registry
        .active
        .get(&stream_id)
        .is_some_and(|stream| stream.owner == window.label())
    {
        registry.active.remove(&stream_id);
    }
    Ok(())
}

async fn stream_events(
    on_event: &Channel<BonsaiStreamEvent>,
    mut cancelled: oneshot::Receiver<()>,
    acknowledged: Arc<Notify>,
) -> Result<(), String> {
    // Reqwest's default has no total/read timeout. Only connecting/headers are bounded.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = tokio::select! {
        biased;
        _ = &mut cancelled => return Ok(()),
        response = tokio::time::timeout(
            CONNECT_TIMEOUT,
            client.get(EVENTS_URL).header(reqwest::header::ACCEPT, "text/event-stream").send(),
        ) => response
            .map_err(|_| "Timed out connecting to Bonsai events".to_string())?
            .map_err(|error| error.to_string())?,
    };
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Bonsai events returned HTTP {}", response.status()));
    }
    let event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
    if !event_stream {
        return Err("Bonsai events did not return text/event-stream".to_string());
    }
    on_event
        .send(BonsaiStreamEvent::Connected)
        .map_err(|error| error.to_string())?;

    let mut decoder = SseDecoder::default();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = &mut cancelled => return Ok(()),
            chunk = response.chunk() => chunk.map_err(|error| error.to_string())?,
        };
        let Some(chunk) = chunk else {
            return Err("Bonsai event stream closed unexpectedly".to_string());
        };
        for byte in chunk {
            if let Some(data) = decoder.push(byte)? {
                on_event
                    .send(BonsaiStreamEvent::Message { data })
                    .map_err(|error| error.to_string())?;
                // One event in flight bounds IPC buffering even if the renderer is slow.
                tokio::select! {
                    biased;
                    _ = &mut cancelled => return Ok(()),
                    _ = acknowledged.notified() => {},
                }
            }
        }
    }
}
