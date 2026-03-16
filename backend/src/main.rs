// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod docx_ops;
mod lily_file;
mod settings;

use docx_ops::{
    copy_template, extract_variables, get_document_html, rename_document, replace_variables,
};
use lily_file::{
    add_client_variable, delete_document, load_lily_file_cmd, new_version_document,
    open_file_in_os, remove_client_variable, save_client_variables, save_variables,
};
use settings::{load_settings, save_settings};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            copy_template,
            extract_variables,
            replace_variables,
            rename_document,
            get_document_html,
            load_settings,
            save_settings,
            list_templates,
            load_lily_file_cmd,
            save_variables,
            save_client_variables,
            add_client_variable,
            remove_client_variable,
            delete_document,
            new_version_document,
            open_file_in_os,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// List all .docx files in a given directory, recursively.
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
    collect_docx_files(path, path, &mut results)?;
    results.sort();
    Ok(results)
}

fn collect_docx_files(
    base: &std::path::Path,
    dir: &std::path::Path,
    results: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_docx_files(base, &path, results)?;
        } else if let Some(ext) = path.extension() {
            if ext.eq_ignore_ascii_case("docx") {
                // Store the path relative to the templates base directory
                if let Ok(relative) = path.strip_prefix(base) {
                    results.push(relative.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(())
}
