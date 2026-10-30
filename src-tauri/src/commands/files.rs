use std::path::Path;

use crate::atomic_file::{
    inspect_save_destination, write_atomic_checked, write_atomic_checked_resolving,
    CheckedSaveResult, FileVersionPrecondition,
};
use crate::workspace::library::BehaviorDirectoryMapping;
use crate::workspace::resolver::resolve_workflow_source_path_io;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDestination {
    path: String,
    file_version: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowSaveSourceContext {
    src: String,
    current_file_path: Option<String>,
}

#[tauri::command]
pub(crate) async fn open_file(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Open Workflow".to_string());

    let file = app
        .dialog()
        .file()
        .set_title(&title)
        .add_filter("Workflow Files", &["xml", "scxml"])
        .blocking_pick_file();

    Ok(file.and_then(|file| {
        file.as_path()
            .map(|path| path.to_string_lossy().to_string())
    }))
}

#[tauri::command]
pub(crate) async fn pick_directory(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select Directory".to_string());

    let folder = app.dialog().file().set_title(&title).blocking_pick_folder();

    Ok(folder.and_then(|folder| {
        folder
            .as_path()
            .map(|path| path.to_string_lossy().to_string())
    }))
}

#[tauri::command]
pub(crate) async fn select_save_destination(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<SaveDestination>, String> {
    let file = app
        .dialog()
        .file()
        .set_title("Save Workflow As")
        .add_filter("Workflow Files", &["xml", "scxml"])
        .set_file_name(&default_name)
        .blocking_save_file();
    let Some(file) = file else {
        return Ok(None);
    };
    let selected = file.as_path().ok_or_else(|| {
        "Selected save location does not have a local filesystem path.".to_string()
    })?;
    let (path, file_version) =
        inspect_save_destination(&selected).map_err(|error| error.to_string())?;
    if file_version.is_some()
        && !app
            .dialog()
            .message(format!(
                "Replace '{}'? Changes made after this confirmation will not be overwritten.",
                path.display()
            ))
            .title("Replace workflow?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    {
        return Ok(None);
    }
    Ok(Some(SaveDestination {
        path: path.to_string_lossy().into_owned(),
        file_version,
    }))
}

#[tauri::command]
pub(crate) async fn save_file(
    content: String,
    path: String,
    expected_file_version: FileVersionPrecondition,
    source_context: Option<WorkflowSaveSourceContext>,
    directories: Vec<BehaviorDirectoryMapping>,
) -> Result<CheckedSaveResult, String> {
    if let Some(source) = source_context {
        return Ok(write_atomic_checked_resolving(
            Path::new(&path),
            content.as_bytes(),
            expected_file_version.as_deref(),
            || {
                resolve_workflow_source_path_io(
                    &source.src,
                    &directories,
                    source.current_file_path.as_deref(),
                )
                .map(|resolved| resolved.path)
            },
        ));
    }
    Ok(write_atomic_checked(
        Path::new(&path),
        content.as_bytes(),
        expected_file_version.as_deref(),
    ))
}

#[tauri::command]
pub(crate) async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|error| error.to_string())
}
