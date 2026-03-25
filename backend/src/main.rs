// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod docx_ops;
mod lily_file;
mod questionnaire;
mod settings;

use docx_ops::{
    copy_template, extract_variables, get_document_html, get_template_text_occurrences,
    insert_template_variable, load_template_schema, remove_template_variable, rename_document,
    replace_variables, save_template_schema,
};
use lily_file::{
    add_client_variable, add_contact, add_required_document, delete_contact, delete_document,
    detect_document_statuses, export_client_data, import_client_data, list_clients_in_library,
    load_client_summaries, load_lily_file_cmd, new_version_document, open_file_in_os,
    remove_client_variable, remove_required_document, resolve_contact_variables,
    save_client_variables, save_contact_bindings, save_questionnaire_note, save_variables,
    set_client_questionnaire, set_document_variables, set_role_override, update_contact,
    update_required_document_notes, update_required_document_status,
};
use questionnaire::{
    create_questionnaire, delete_questionnaire, duplicate_questionnaire, load_questionnaire,
    load_questionnaire_index, migrate_questionnaires, save_questionnaire,
    set_active_questionnaire,
};
use settings::{load_settings, save_settings};
use tauri::Manager;
use tracing_subscriber::EnvFilter;

fn init_logging() {
    let log_dir = dirs::config_dir()
        .map(|d| d.join("lily").join("logs"))
        .expect("Could not determine config directory");
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "lily.log");

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("lily=info")),
        )
        .with_writer(file_appender)
        .with_ansi(false)
        .init();

    tracing::info!("Lily starting up");
}

fn main() {
    init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Restore saved window size from settings, if available.
            if let Ok(settings) = settings::load_settings() {
                if let (Some(w), Some(h)) = (settings.window_width, settings.window_height) {
                    if let Some(window) = app.get_webview_window("main") {
                        let size = tauri::LogicalSize::new(w as f64, h as f64);
                        let _ = window.set_size(size);
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Save current window size to settings before closing.
                if let Ok(size) = window.inner_size() {
                    if let Ok(scale) = window.scale_factor() {
                        let logical_w = (size.width as f64 / scale).round() as u32;
                        let logical_h = (size.height as f64 / scale).round() as u32;
                        if let Ok(mut current) = settings::load_settings() {
                            current.window_width = Some(logical_w);
                            current.window_height = Some(logical_h);
                            let _ = settings::save_settings(current);
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            copy_template,
            extract_variables,
            replace_variables,
            rename_document,
            get_document_html,
            get_template_text_occurrences,
            insert_template_variable,
            remove_template_variable,
            load_template_schema,
            save_template_schema,
            load_settings,
            save_settings,
            list_templates,
            load_lily_file_cmd,
            save_variables,
            save_client_variables,
            add_client_variable,
            remove_client_variable,
            set_document_variables,
            delete_document,
            new_version_document,
            open_file_in_os,
            add_contact,
            update_contact,
            delete_contact,
            save_contact_bindings,
            resolve_contact_variables,
            save_questionnaire_note,
            set_role_override,
            set_client_questionnaire,
            export_client_data,
            import_client_data,
            load_questionnaire_index,
            load_questionnaire,
            save_questionnaire,
            create_questionnaire,
            duplicate_questionnaire,
            delete_questionnaire,
            set_active_questionnaire,
            migrate_questionnaires,
            add_required_document,
            update_required_document_status,
            update_required_document_notes,
            remove_required_document,
            detect_document_statuses,
            load_client_summaries,
            list_clients_in_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// List all .docx and .dotx template files in a given directory, recursively.
#[tauri::command]
fn list_templates(templates_dir: String) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(&templates_dir);
    if !path.exists() {
        return Err(format!(
            "Templates directory does not exist: {}",
            templates_dir
        ));
    }
    let mut results = Vec::new();
    collect_template_files(path, path, &mut results)?;
    results.sort();
    Ok(results)
}

fn collect_template_files(
    base: &std::path::Path,
    dir: &std::path::Path,
    results: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_template_files(base, &path, results)?;
        } else if let Some(ext) = path.extension() {
            if ext.eq_ignore_ascii_case("docx") || ext.eq_ignore_ascii_case("dotx") {
                // Store the path relative to the templates base directory
                if let Ok(relative) = path.strip_prefix(base) {
                    results.push(relative.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(())
}
