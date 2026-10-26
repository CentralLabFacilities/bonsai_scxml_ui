//! Tauri-side bridge to Memory WebSupport. A webview cannot rely on the
//! local Memory server advertising CORS headers, but reqwest can read it.
//! Only fixed loopback endpoints are reachable; no arbitrary URL proxy.
use std::sync::Mutex;
use std::time::Duration;

use tauri::{ipc::Channel, State};

const MEMORY_BASE: &str = "http://127.0.0.1:8081";
const MAX_SSE_EVENT: usize = 1024 * 1024;

#[derive(Default)]
struct ActiveSubscription {
    last_id: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub(crate) struct MemorySubscription(Mutex<ActiveSubscription>);

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum MemoryMessage {
    Connected,
    Event { name: String, data: String },
    Error { message: String },
}

fn client(stream: bool) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    // Bound HTTP snapshot reads; SSE must remain open indefinitely.
    let builder = if stream { builder } else { builder.timeout(Duration::from_secs(5)) };
    builder.build().map_err(|err| err.to_string())
}

async fn read_json(request: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let response = request.send().await.map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Memory WebSupport HTTP {}", response.status()));
    }
    response.json::<serde_json::Value>().await.map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn memory_used_slots() -> Result<serde_json::Value, String> {
    read_json(client(false)?.get(format!("{MEMORY_BASE}/getUsedSlots"))).await
}

#[tauri::command]
pub(crate) async fn memory_get_slot(path: String) -> Result<serde_json::Value, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("Invalid MemorySlot path".to_string());
    }
    read_json(client(false)?.get(format!("{MEMORY_BASE}/getSlot")).query(&[("path", path)])).await
}

// SSE messages have explicit `event: slot_written` / `slot_cleared` fields.
// Preserve those fields, unlike a default-message-only event decoder.
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    event_name: String,
    data: Vec<u8>,
    skip_lf: bool,
}

impl SseDecoder {
    fn push(&mut self, byte: u8) -> Result<Option<(String, String)>, String> {
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' { return Ok(None); }
        }
        if byte == b'\r' || byte == b'\n' {
            self.skip_lf = byte == b'\r';
            return self.finish_line();
        }
        if self.line.len() + self.data.len() >= MAX_SSE_EVENT {
            return Err("Memory SSE message exceeds size limit".to_string());
        }
        self.line.push(byte);
        Ok(None)
    }

    fn finish_line(&mut self) -> Result<Option<(String, String)>, String> {
        let line = std::mem::take(&mut self.line);
        if line.is_empty() {
            if self.data.is_empty() { self.event_name.clear(); return Ok(None); }
            let mut data = std::mem::take(&mut self.data);
            data.pop(); // remove final newline, per SSE framing
            let text = String::from_utf8(data).map_err(|e| e.to_string())?;
            let event_name = std::mem::take(&mut self.event_name);
            return Ok(Some((if event_name.is_empty() { "message".into() } else { event_name }, text)));
        }
        if line.starts_with(b":") { return Ok(None); }
        let split = line.iter().position(|&x| x == b':');
        let (field, raw) = match split {
            Some(i) => (&line[..i], &line[i + 1..]),
            None => (&line[..], &[][..]),
        };
        let value = raw.strip_prefix(b" ").unwrap_or(raw);
        match field {
            b"event" => self.event_name = String::from_utf8_lossy(value).into_owned(),
            b"data" => {
                if self.line.len() + self.data.len() + value.len() + 1 > MAX_SSE_EVENT {
                    return Err("Memory SSE message exceeds size limit".to_string());
                }
                self.data.extend_from_slice(value);
                self.data.push(b'\n');
            }
            _ => {}
        }
        Ok(None)
    }
}

#[tauri::command]
pub(crate) fn memory_subscribe(
    on_event: Channel<MemoryMessage>,
    subscription: State<'_, MemorySubscription>,
) -> Result<u64, String> {
    let mut active = subscription.0.lock().map_err(|err| err.to_string())?;
    active.last_id = active.last_id.checked_add(1).ok_or("Memory subscription ID exhausted")?;
    let stream_id = active.last_id;
    if let Some(old) = active.task.take() { old.abort(); }
    active.task = Some(tauri::async_runtime::spawn(async move {
        if let Err(message) = stream_memory(on_event.clone()).await {
            let _ = on_event.send(MemoryMessage::Error { message });
        }
    }));
    Ok(stream_id)
}

#[tauri::command]
pub(crate) fn memory_unsubscribe(stream_id: u64, subscription: State<'_, MemorySubscription>) -> Result<(), String> {
    let mut active = subscription.0.lock().map_err(|err| err.to_string())?;
    // Ignore delayed cleanup from an older React effect/subscription.
    if active.last_id == stream_id {
        if let Some(previous) = active.task.take() { previous.abort(); }
    }
    Ok(())
}

async fn stream_memory(channel: Channel<MemoryMessage>) -> Result<(), String> {
    let mut response = client(true)?.get(format!("{MEMORY_BASE}/events"))
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send().await.map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Memory SSE HTTP {}", response.status()));
    }
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|s| s.to_str().ok()).unwrap_or("");
    if !content_type.split(';').next().is_some_and(|s| s.trim() == "text/event-stream") {
        return Err(format!("Expected Memory text/event-stream, got {content_type}"));
    }
    channel.send(MemoryMessage::Connected).map_err(|err| err.to_string())?;
    let mut decoder = SseDecoder::default();
    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        for byte in chunk {
            if let Some((name, data)) = decoder.push(byte)? {
                channel.send(MemoryMessage::Event { name, data }).map_err(|err| err.to_string())?;
            }
        }
    }
    Err("Memory event stream closed; reconnect required".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_named_events_split_at_arbitrary_boundaries() {
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        let s = b": connected\r\nevent: slot_written\r\ndata: {\"path\":\"/a\",\"value\":\"hello\"}\r\n\r\nevent: slot_cleared\ndata: {\"path\":\"/b\"}\n\n";
        for chunk in s.chunks(1) {
            for &byte in chunk { if let Some(event) = decoder.push(byte).unwrap() { events.push(event); } }
        }
        assert_eq!(events[0].0, "slot_written");
        assert!(events[0].1.contains("hello"));
        assert_eq!(events[1].0, "slot_cleared");
    }
}
