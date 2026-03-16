use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const SIDECAR_FILENAME: &str = ".lily.json";

/// Top-level sidecar file that lives in each working directory.
#[derive(Debug, Serialize, Deserialize)]
pub struct SidecarFile {
    /// Schema version for forward compatibility.
    pub version: u32,
    /// Map from document filename to its metadata.
    pub documents: HashMap<String, DocumentMeta>,
}

/// Metadata for a single document in the working directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMeta {
    /// Relative path of the source template within the templates directory
    /// (e.g., "Trust Templates/Revocable Trust.docx").
    pub template_rel_path: String,
    /// When the document was first created from the template.
    pub created_at: DateTime<Utc>,
    /// When the document was last saved/modified through Lily.
    pub modified_at: DateTime<Utc>,
    /// Last-known variable values, preserved across sessions.
    pub variable_values: HashMap<String, String>,
}

impl Default for SidecarFile {
    fn default() -> Self {
        Self {
            version: 1,
            documents: HashMap::new(),
        }
    }
}

/// Build the path to the sidecar file for a given working directory.
fn sidecar_path(working_dir: &str) -> std::path::PathBuf {
    Path::new(working_dir).join(SIDECAR_FILENAME)
}

/// Read the sidecar file from a working directory.
/// Returns a default (empty) sidecar if the file doesn't exist yet.
pub fn read_sidecar(working_dir: &str) -> Result<SidecarFile, String> {
    let path = sidecar_path(working_dir);
    if !path.exists() {
        return Ok(SidecarFile::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read sidecar file: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse sidecar file: {}", e))
}

/// Write the sidecar file to disk.
fn write_sidecar(working_dir: &str, sidecar: &SidecarFile) -> Result<(), String> {
    let path = sidecar_path(working_dir);
    let content = serde_json::to_string_pretty(sidecar)
        .map_err(|e| format!("Failed to serialize sidecar: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write sidecar file: {}", e))?;
    Ok(())
}

/// Record a newly created document in the sidecar.
/// Called when a template is copied into the working directory.
pub fn record_document(
    working_dir: &str,
    filename: &str,
    template_rel_path: &str,
) -> Result<(), String> {
    let mut sidecar = read_sidecar(working_dir)?;
    let now = Utc::now();
    sidecar.documents.insert(
        filename.to_string(),
        DocumentMeta {
            template_rel_path: template_rel_path.to_string(),
            created_at: now,
            modified_at: now,
            variable_values: HashMap::new(),
        },
    );
    write_sidecar(working_dir, &sidecar)
}

/// Update the saved variable values and modified timestamp for a document.
pub fn update_document_variables(
    working_dir: &str,
    filename: &str,
    variable_values: HashMap<String, String>,
) -> Result<(), String> {
    let mut sidecar = read_sidecar(working_dir)?;
    match sidecar.documents.get_mut(filename) {
        Some(meta) => {
            meta.variable_values = variable_values;
            meta.modified_at = Utc::now();
        }
        None => {
            return Err(format!("Document '{}' not found in sidecar file", filename));
        }
    }
    write_sidecar(working_dir, &sidecar)
}

// --- Tauri commands ---

/// Load the sidecar file for a working directory.
/// Returns the full sidecar data so the frontend can inspect document metadata.
#[tauri::command]
pub fn load_sidecar(working_dir: String) -> Result<SidecarFile, String> {
    read_sidecar(&working_dir)
}

/// Save variable values for a document and update its modified timestamp.
#[tauri::command]
pub fn save_document_meta(
    working_dir: String,
    filename: String,
    variable_values: HashMap<String, String>,
) -> Result<(), String> {
    update_document_variables(&working_dir, &filename, variable_values)
}
