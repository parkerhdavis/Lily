use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

const LILY_EXT: &str = "lily";
const OLD_SIDECAR_FILENAME: &str = ".lily.json";
const CURRENT_VERSION: u32 = 4;

/// A contact associated with a client — a person referenced across documents
/// (e.g., a family member, agent, or trustee).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub full_name: String,
    pub first_name: String,
    pub last_name: String,
    pub relationship: String,
    pub phone: String,
    pub email: String,
    pub address: String,
    pub city: String,
    pub state: String,
    pub zip: String,
}

/// Maps a "role" (e.g., "Healthcare POA Agent") to a contact, plus a mapping
/// from variable display names to contact property keys. When a contact is
/// selected for a role, the mapped variables auto-fill from the contact's
/// properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactBinding {
    /// The contact ID this role is bound to, or `None` for manual ("Other") entry.
    pub contact_id: Option<String>,
    /// Map from variable display name → contact property key.
    /// e.g., `"POA Agent Full Name" → "full_name"`
    pub variable_mappings: HashMap<String, String>,
}

/// Notes attached to a questionnaire section (client-facing and internal).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SectionNotes {
    /// Notes from/for the client (visible in client-facing tools).
    #[serde(default)]
    pub client: String,
    /// Internal notes for the legal team (not visible to clients).
    #[serde(default)]
    pub internal: String,
}

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
    /// Display names of conditional (ternary) variables. These render as
    /// toggles in the UI and store `"true"` / `"false"` as their value.
    #[serde(default)]
    pub conditional_variables: Vec<String>,
    /// Full conditional definitions extracted from the template, keyed by
    /// display name.  Each entry holds every distinct definition string
    /// (`"Label ?? true_text :: false_text"`) found in the template for that
    /// label.  Stored permanently so that conditional logic survives across
    /// save/re-open cycles even when placeholders have been replaced.
    #[serde(default)]
    pub conditional_definitions: HashMap<String, Vec<String>>,
    /// Map from document filename to its metadata.
    pub documents: HashMap<String, DocumentMeta>,
    /// Contacts associated with this client.
    #[serde(default)]
    pub contacts: Vec<Contact>,
    /// Contact-to-role bindings, keyed by role name.
    #[serde(default)]
    pub contact_bindings: HashMap<String, ContactBinding>,
    /// Questionnaire notes keyed by section title.
    #[serde(default)]
    pub questionnaire_notes: HashMap<String, SectionNotes>,
    /// ID of the questionnaire definition used for this client.
    #[serde(default)]
    pub questionnaire_id: Option<String>,
    /// Version of the questionnaire definition when it was last applied.
    #[serde(default)]
    pub questionnaire_version: Option<u32>,
}

/// A per-document override for a contact role, allowing a document to use
/// a different contact (or custom values) than what the questionnaire set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleOverride {
    /// The contact ID for this override, or `None` for custom manual values.
    pub contact_id: Option<String>,
    /// The specific variable values for this override.
    pub values: HashMap<String, String>,
}

/// Metadata for a single document in the working directory.
/// Variable values are stored at the top-level `LilyFile.variables`, not here.
/// However, the *names* of variables this document uses are stored here so that
/// reopening a saved document (where `{Placeholder}` text has been replaced
/// with actual values) still knows which variables apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMeta {
    /// Relative path of the source template within the templates directory
    /// (e.g., "Trust Templates/Revocable Trust.docx").
    pub template_rel_path: String,
    /// When the document was first created from the template.
    pub created_at: DateTime<Utc>,
    /// When the document was last saved/modified through Lily.
    pub modified_at: DateTime<Utc>,
    /// Display names of the variables this document uses, recorded when the
    /// template is first processed. Used to restore the variable list after
    /// placeholders have been replaced with real values.
    #[serde(default)]
    pub variable_names: Vec<String>,
    /// Per-document role overrides. When a role is present here, the document
    /// uses the override's values instead of the questionnaire's binding.
    #[serde(default)]
    pub role_overrides: HashMap<String, RoleOverride>,
}

impl Default for LilyFile {
    fn default() -> Self {
        Self {
            lily_version: CURRENT_VERSION,
            variables: HashMap::new(),
            conditional_variables: Vec::new(),
            conditional_definitions: HashMap::new(),
            documents: HashMap::new(),
            contacts: Vec::new(),
            contact_bindings: HashMap::new(),
            questionnaire_notes: HashMap::new(),
            questionnaire_id: None,
            questionnaire_version: None,
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
        let mut lily: LilyFile = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse .lily file: {}", e))?;

        // Auto-migrate older versions: new fields have #[serde(default)] so
        // they deserialize as empty; just bump the version and persist.
        if lily.lily_version < CURRENT_VERSION {
            lily.lily_version = CURRENT_VERSION;
            write_lily_file(working_dir, &lily)?;
        }

        return Ok(lily);
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

        // Create a document entry; derive variable_names from the legacy keys
        let variable_names: Vec<String> = meta.variable_values.keys().cloned().collect();
        lily.documents.insert(
            filename,
            DocumentMeta {
                template_rel_path: meta.template_rel_path,
                created_at: meta.created_at,
                modified_at: meta.modified_at,
                variable_names,
                role_overrides: HashMap::new(),
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
            variable_names: Vec::new(),
            role_overrides: HashMap::new(),
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

/// Store the list of variable names (display names) that a document uses,
/// along with the list of conditional variable names and their full
/// definitions.  Called after extracting variables from a freshly created
/// document so that the variable list and conditional logic survive across
/// save cycles (where placeholders are replaced with real values in the docx).
#[tauri::command]
pub fn set_document_variables(
    working_dir: String,
    filename: String,
    variable_names: Vec<String>,
    conditional_names: Vec<String>,
    conditional_definitions: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    if let Some(meta) = lily.documents.get_mut(&filename) {
        meta.variable_names = variable_names;
    } else {
        return Err(format!("Document '{}' not found in .lily file", filename));
    }
    // Merge any new conditional variable names into the project-level list
    for name in conditional_names {
        if !lily.conditional_variables.contains(&name) {
            lily.conditional_variables.push(name);
        }
    }
    // Merge conditional definitions into the project-level map
    for (label, defs) in conditional_definitions {
        let entry = lily.conditional_definitions.entry(label).or_default();
        for def in defs {
            if !entry.contains(&def) {
                entry.push(def);
            }
        }
    }
    write_lily_file(&working_dir, &lily)
}

/// Delete a document file from disk and remove its entry from the .lily file.
#[tauri::command]
pub fn delete_document(working_dir: String, filename: String) -> Result<(), String> {
    let file_path = Path::new(&working_dir).join(&filename);

    // Remove the file from disk
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete file '{}': {}", filename, e))?;
    }

    // Remove the entry from the .lily file
    let mut lily = read_lily_file(&working_dir)?;
    lily.documents.remove(&filename);
    write_lily_file(&working_dir, &lily)
}

/// Create a new versioned copy of an existing document.
/// The new filename is `{basename}-{YYYYMMDD}.docx`. If that already exists,
/// appends a numeric suffix like `-{YYYYMMDD}-2.docx`.
/// Returns the filename of the new version.
#[tauri::command]
pub fn new_version_document(working_dir: String, filename: String) -> Result<String, String> {
    let src_path = Path::new(&working_dir).join(&filename);
    if !src_path.exists() {
        return Err(format!("Document '{}' not found", filename));
    }

    let lily = read_lily_file(&working_dir)?;
    let meta = lily
        .documents
        .get(&filename)
        .ok_or_else(|| format!("Document '{}' not found in .lily file", filename))?;

    // Build the new filename with today's date
    let basename = filename.trim_end_matches(".docx").trim_end_matches(".DOCX");
    let date_str = Utc::now().format("%Y%m%d").to_string();
    let mut new_filename = format!("{}-{}.docx", basename, date_str);

    // Handle collision: append a numeric suffix
    let mut counter = 2u32;
    while Path::new(&working_dir).join(&new_filename).exists() {
        new_filename = format!("{}-{}-{}.docx", basename, date_str, counter);
        counter += 1;
    }

    // Copy the file
    let dest_path = Path::new(&working_dir).join(&new_filename);
    fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to copy document: {}", e))?;

    // Record the new document in the .lily file, sharing the same template origin
    // and variable_names from the source document
    let template_rel_path = meta.template_rel_path.clone();
    let variable_names = meta.variable_names.clone();
    drop(lily);

    let mut lily = read_lily_file(&working_dir)?;
    let now = Utc::now();
    lily.documents.insert(
        new_filename.clone(),
        DocumentMeta {
            template_rel_path,
            created_at: now,
            modified_at: now,
            variable_names,
            role_overrides: HashMap::new(),
        },
    );
    write_lily_file(&working_dir, &lily)?;

    Ok(new_filename)
}

/// Open a file using the OS default application (e.g., open a .docx template
/// in Word). Uses `xdg-open` on Linux, `open` on macOS, `start` on Windows.
#[tauri::command]
pub fn open_file_in_os(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(&file_path)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&file_path).spawn();

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &file_path])
        .spawn();

    result.map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

// ─── Contact CRUD commands ──────────────────────────────────────────────────

/// Helper: look up a contact property by its key name.
fn get_contact_property(contact: &Contact, key: &str) -> String {
    match key {
        "full_name" => contact.full_name.clone(),
        "first_name" => contact.first_name.clone(),
        "last_name" => contact.last_name.clone(),
        "relationship" => contact.relationship.clone(),
        "phone" => contact.phone.clone(),
        "email" => contact.email.clone(),
        "address" => contact.address.clone(),
        "city" => contact.city.clone(),
        "state" => contact.state.clone(),
        "zip" => contact.zip.clone(),
        _ => String::new(),
    }
}

/// Add a new contact to the .lily file. A UUID is generated for the `id` field
/// (any value provided is overwritten). Returns the contact with its assigned ID.
#[tauri::command]
pub fn add_contact(working_dir: String, mut contact: Contact) -> Result<Contact, String> {
    contact.id = Uuid::new_v4().to_string();
    let mut lily = read_lily_file(&working_dir)?;
    lily.contacts.push(contact.clone());
    write_lily_file(&working_dir, &lily)?;
    Ok(contact)
}

/// Update an existing contact by ID. Returns an error if the contact is not found.
#[tauri::command]
pub fn update_contact(working_dir: String, contact: Contact) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    let pos = lily
        .contacts
        .iter()
        .position(|c| c.id == contact.id)
        .ok_or_else(|| format!("Contact '{}' not found", contact.id))?;
    lily.contacts[pos] = contact;
    write_lily_file(&working_dir, &lily)
}

/// Delete a contact by ID. Also removes any contact_bindings that reference it.
#[tauri::command]
pub fn delete_contact(working_dir: String, contact_id: String) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    lily.contacts.retain(|c| c.id != contact_id);
    // Clear bindings that reference this contact
    for binding in lily.contact_bindings.values_mut() {
        if binding.contact_id.as_deref() == Some(&contact_id) {
            binding.contact_id = None;
        }
    }
    write_lily_file(&working_dir, &lily)
}

/// Replace the entire contact_bindings map in the .lily file.
#[tauri::command]
pub fn save_contact_bindings(
    working_dir: String,
    contact_bindings: HashMap<String, ContactBinding>,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    lily.contact_bindings = contact_bindings;
    write_lily_file(&working_dir, &lily)
}

/// Resolve all contact bindings: for each binding with a contact_id, write
/// the contact's property values into the variables pool and persist.
/// Also auto-sets `Has {role}` conditional variables to `"true"` when a
/// contact is bound to a role, or `"false"` when the binding has no contact.
#[tauri::command]
pub fn resolve_contact_variables(working_dir: String) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    for (role, binding) in &lily.contact_bindings {
        let has_key = format!("Has {}", role);
        match &binding.contact_id {
            Some(id) => {
                let contact = lily.contacts.iter().find(|c| &c.id == id);
                if let Some(contact) = contact {
                    for (var_name, prop_key) in &binding.variable_mappings {
                        let value = get_contact_property(contact, prop_key);
                        lily.variables.insert(var_name.clone(), value);
                    }
                    lily.variables.insert(has_key, "true".to_string());
                } else {
                    lily.variables.insert(has_key, "false".to_string());
                }
            }
            None => {
                // "Other" (manual entry) — properties are set manually,
                // but the role is still considered "has" if any mapped
                // variable has a value.
                let any_filled = binding.variable_mappings.keys().any(|k| {
                    lily.variables.get(k).is_some_and(|v| !v.is_empty())
                });
                lily.variables
                    .insert(has_key, if any_filled { "true" } else { "false" }.to_string());
            }
        }
    }
    write_lily_file(&working_dir, &lily)
}

/// Set or remove a per-document role override.
/// If `override_data` is `Some`, the role is overridden for this document.
/// If `None`, the override is removed (re-linking to the questionnaire).
#[tauri::command]
pub fn set_role_override(
    working_dir: String,
    filename: String,
    role: String,
    override_data: Option<RoleOverride>,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    let meta = lily
        .documents
        .get_mut(&filename)
        .ok_or_else(|| format!("Document '{}' not found in .lily file", filename))?;
    match override_data {
        Some(data) => {
            meta.role_overrides.insert(role, data);
        }
        None => {
            meta.role_overrides.remove(&role);
        }
    }
    write_lily_file(&working_dir, &lily)
}

/// Save a questionnaire note (client or internal) for a specific section.
#[tauri::command]
pub fn save_questionnaire_note(
    working_dir: String,
    section: String,
    note_kind: String,
    value: String,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    let notes = lily
        .questionnaire_notes
        .entry(section)
        .or_default();
    match note_kind.as_str() {
        "client" => notes.client = value,
        "internal" => notes.internal = value,
        _ => return Err(format!("Invalid note kind: {}", note_kind)),
    }
    write_lily_file(&working_dir, &lily)
}

/// Stamp the questionnaire ID and version into the .lily file for a client.
#[tauri::command]
pub fn set_client_questionnaire(
    working_dir: String,
    questionnaire_id: String,
    questionnaire_version: u32,
) -> Result<(), String> {
    let mut lily = read_lily_file(&working_dir)?;
    lily.questionnaire_id = Some(questionnaire_id);
    lily.questionnaire_version = Some(questionnaire_version);
    write_lily_file(&working_dir, &lily)
}
