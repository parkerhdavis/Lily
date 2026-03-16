use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const LILY_EXT: &str = "lily";
const OLD_SIDECAR_FILENAME: &str = ".lily.json";

/// Top-level `.lily` project file that lives in each client/working directory.
/// Acts as both a configuration file and (via OS file-type association) a
/// project launcher — analogous to Unreal Engine's `.uproject` files.
///
/// All variables are stored at the client level (shared across every document
/// in the directory). Document entries track only provenance and timestamps.
#[derive(Debug, Serialize, Deserialize)]
pub struct LilyFile {
    /// Schema version for forward compatibility.
    pub lily_version: u32,
    /// Client-level variable values shared across all documents.
    pub variables: HashMap<String, String>,
    /// Map from document filename to its metadata.
    pub documents: HashMap<String, DocumentMeta>,
}

/// Metadata for a single document in the working directory.
/// Variables are stored at the top-level `LilyFile.variables`, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMeta {
    /// Relative path of the source template within the templates directory
    /// (e.g., "Trust Templates/Revocable Trust.docx").
    pub template_rel_path: String,
    /// When the document was first created from the template.
    pub created_at: DateTime<Utc>,
    /// When the document was last saved/modified through Lily.
    pub modified_at: DateTime<Utc>,
}

impl Default for LilyFile {
    fn default() -> Self {
        Self {
            lily_version: 2,
            variables: HashMap::new(),
            documents: HashMap::new(),
        }
    }
}

// ─── Legacy sidecar types (for migration only) ─────────────────────────────

#[derive(Debug, Deserialize)]
struct LegacySidecarFile {
    #[allow(dead_code)]
    version: u32,
    documents: HashMap<String, LegacyDocumentMeta>,
}

#[derive(Debug, Deserialize)]
struct LegacyDocumentMeta {
    template_rel_path: String,
    created_at: DateTime<Utc>,
    modified_at: DateTime<Utc>,
    variable_values: HashMap<String, String>,
}

// ─── File discovery & I/O ───────────────────────────────────────────────────

/// Find the `.lily` file in a working directory.
/// Returns `None` if no `.lily` file exists. If multiple `.lily` files exist,
/// returns the first one found (alphabetically).
fn find_lily_file(working_dir: &str) -> Result<Option<std::path::PathBuf>, String> {
    let dir = Path::new(working_dir);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", working_dir));
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut lily_files: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == LILY_EXT {
                    lily_files.push(path);
                }
            }
        }
    }

    lily_files.sort();
    Ok(lily_files.into_iter().next())
}

/// Read the `.lily` file from a working directory.
/// If no `.lily` file exists, checks for a legacy `.lily.json` and migrates it.
/// Returns a default (empty) LilyFile if neither exists.
pub fn read_lily_file(working_dir: &str) -> Result<LilyFile, String> {
    // Check for existing .lily file
    if let Some(path) = find_lily_file(working_dir)? {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read .lily file: {}", e))?;
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse .lily file: {}", e));
    }

    // Check for legacy .lily.json and migrate
    let legacy_path = Path::new(working_dir).join(OLD_SIDECAR_FILENAME);
    if legacy_path.exists() {
        return migrate_legacy_sidecar(working_dir);
    }

    Ok(LilyFile::default())
}

/// Write the `.lily` file to disk.
/// If a `.lily` file already exists in the directory, it is overwritten.
/// Otherwise, a new file is created using the directory name as the filename
/// (e.g., `Doe, Jane.lily` for a directory named `Doe, Jane`).
fn write_lily_file(working_dir: &str, lily: &LilyFile) -> Result<(), String> {
    let path = match find_lily_file(working_dir)? {
        Some(existing) => existing,
        None => {
            // Derive filename from the directory name
            let dir = Path::new(working_dir);
            let dir_name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string());
            dir.join(format!("{}.lily", dir_name))
        }
    };

    let content = serde_json::to_string_pretty(lily)
        .map_err(|e| format!("Failed to serialize .lily file: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write .lily file: {}", e))?;
    Ok(())
}

// ─── Migration ──────────────────────────────────────────────────────────────

/// Migrate a legacy `.lily.json` sidecar to the new `.lily` format.
/// All per-document variable values are merged into the top-level variable pool.
/// The old `.lily.json` file is removed after successful migration.
fn migrate_legacy_sidecar(working_dir: &str) -> Result<LilyFile, String> {
    let legacy_path = Path::new(working_dir).join(OLD_SIDECAR_FILENAME);
    let content = fs::read_to_string(&legacy_path)
        .map_err(|e| format!("Failed to read legacy sidecar: {}", e))?;
    let legacy: LegacySidecarFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse legacy sidecar: {}", e))?;

    let mut lily = LilyFile::default();

    for (filename, meta) in legacy.documents {
        // Merge variable values into the top-level pool
        for (key, value) in &meta.variable_values {
            if !value.is_empty() {
                // Only overwrite if the top-level doesn't already have a value
                lily.variables
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        }

        // Create a document entry without variable_values
        lily.documents.insert(
            filename,
            DocumentMeta {
                template_rel_path: meta.template_rel_path,
                created_at: meta.created_at,
                modified_at: meta.modified_at,
            },
        );
    }

    // Write the new .lily file
    write_lily_file(working_dir, &lily)?;

    // Remove the old .lily.json
    if let Err(e) = fs::remove_file(&legacy_path) {
        eprintln!(
            "Warning: migrated to .lily but failed to remove old .lily.json: {}",
            e
        );
    }

    Ok(lily)
}

// ─── CRUD operations ────────────────────────────────────────────────────────

/// Record a newly created document in the .lily file.
/// Called when a template is copied into the working directory.
pub fn record_document(
    working_dir: &str,
    filename: &str,
    template_rel_path: &str,
) -> Result<(), String> {
    let mut lily = read_lily_file(working_dir)?;
    let now = Utc::now();
    lily.documents.insert(
        filename.to_string(),
        DocumentMeta {
            template_rel_path: template_rel_path.to_string(),
            created_at: now,
            modified_at: now,
        },
    );
    write_lily_file(working_dir, &lily)
}

/// Update the client-level variable values and the modified timestamp for a
/// specific document. All variables are stored at the top level (shared across
/// documents), so this merges the provided values into the existing pool.
pub fn update_variables(
    working_dir: &str,
    filename: &str,
    variable_values: HashMap<String, String>,
) -> Result<(), String> {
    let mut lily = read_lily_file(working_dir)?;

    // Merge variable values into the top-level pool
    for (key, value) in variable_values {
        lily.variables.insert(key, value);
    }

    // Update the document's modified timestamp
    if let Some(meta) = lily.documents.get_mut(filename) {
        meta.modified_at = Utc::now();
    }

    write_lily_file(working_dir, &lily)
}

/// Rename a document entry in the .lily file (update the key from old to new filename).
pub fn rename_document_entry(
    working_dir: &str,
    old_filename: &str,
    new_filename: &str,
) -> Result<(), String> {
    let mut lily = read_lily_file(working_dir)?;
    match lily.documents.remove(old_filename) {
        Some(mut meta) => {
            meta.modified_at = Utc::now();
            lily.documents.insert(new_filename.to_string(), meta);
        }
        None => {
            return Err(format!(
                "Document '{}' not found in .lily file",
                old_filename
            ));
        }
    }
    write_lily_file(working_dir, &lily)
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Load the .lily file for a working directory.
/// Returns the full data so the frontend can inspect document metadata and variables.
#[tauri::command]
pub fn load_lily_file_cmd(working_dir: String) -> Result<LilyFile, String> {
    read_lily_file(&working_dir)
}

/// Save variable values for a document and update its modified timestamp.
#[tauri::command]
pub fn save_variables(
    working_dir: String,
    filename: String,
    variable_values: HashMap<String, String>,
) -> Result<(), String> {
    update_variables(&working_dir, &filename, variable_values)
}

/// Save client-level variable values without associating them with a specific
/// document. Used by the Client Hub for direct variable editing.
#[tauri::command]
pub fn save_client_variables(
    working_dir: String,
    variable_values: HashMap<String, String>,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;

    for (key, value) in variable_values {
        lily.variables.insert(key, value);
    }

    write_lily_file(&working_dir, &lily)
}

/// Add a new variable to the client-level pool with an empty value.
/// Returns an error if the variable already exists (case-sensitive check on the key).
#[tauri::command]
pub fn add_client_variable(working_dir: String, variable_name: String) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;

    if lily.variables.contains_key(&variable_name) {
        return Err(format!("Variable '{}' already exists", variable_name));
    }

    lily.variables.insert(variable_name, String::new());
    write_lily_file(&working_dir, &lily)
}

/// Remove a variable from the client-level pool.
#[tauri::command]
pub fn remove_client_variable(working_dir: String, variable_name: String) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    lily.variables.remove(&variable_name);
    write_lily_file(&working_dir, &lily)
}
