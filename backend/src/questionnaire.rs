use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

// ─── Data structures ─────────────────────────────────────────────────────────

/// A single question in a questionnaire definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionDef {
    pub kind: String,
    /// Remaining fields vary by kind — stored as a flat JSON map.
    #[serde(flatten)]
    pub fields: Value,
}

/// A tab in the questionnaire UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabDef {
    pub id: String,
    pub label: String,
}

/// A section grouping related questions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionDef {
    pub title: String,
    pub tab: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// "standard" or "contacts". Defaults to "standard" if absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub questions: Vec<QuestionDef>,
}

/// A complete questionnaire definition file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionnaireDefFile {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub tabs: Vec<TabDef>,
    pub sections: Vec<SectionDef>,
}

/// An entry in the questionnaire index (metadata only, no sections).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionnaireIndexEntry {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}

/// The questionnaire index file — lists all questionnaire definitions and
/// which one is currently active.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionnaireIndex {
    pub questionnaires: Vec<QuestionnaireIndexEntry>,
    #[serde(default)]
    pub active_questionnaire_id: Option<String>,
}

// ─── File paths ──────────────────────────────────────────────────────────────

fn questionnaires_dir() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Could not determine config directory".to_string())?;
    let dir = config_dir.join("lily").join("questionnaires");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create questionnaires directory: {}", e))?;
    }
    Ok(dir)
}

fn index_path() -> Result<PathBuf, String> {
    Ok(questionnaires_dir()?.join("index.json"))
}

fn questionnaire_path(id: &str) -> Result<PathBuf, String> {
    Ok(questionnaires_dir()?.join(format!("{}.json", id)))
}

// ─── Index I/O ───────────────────────────────────────────────────────────────

fn read_index() -> Result<QuestionnaireIndex, String> {
    let path = index_path()?;
    if !path.exists() {
        return Ok(QuestionnaireIndex {
            questionnaires: vec![],
            active_questionnaire_id: None,
        });
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read index: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse index: {}", e))
}

fn write_index(index: &QuestionnaireIndex) -> Result<(), String> {
    let path = index_path()?;
    let content = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialize index: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write index: {}", e))
}

// ─── Questionnaire file I/O ─────────────────────────────────────────────────

fn read_questionnaire(id: &str) -> Result<QuestionnaireDefFile, String> {
    let path = questionnaire_path(id)?;
    if !path.exists() {
        return Err(format!("Questionnaire not found: {}", id));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read questionnaire: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse questionnaire: {}", e))
}

fn write_questionnaire(q: &QuestionnaireDefFile) -> Result<(), String> {
    let path = questionnaire_path(&q.id)?;
    let content = serde_json::to_string_pretty(q)
        .map_err(|e| format!("Failed to serialize questionnaire: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write questionnaire: {}", e))
}

// ─── Seed / default questionnaire ───────────────────────────────────────────

const SEED_QUESTIONNAIRE_JSON: &str = include_str!("seed_questionnaire.json");

fn ensure_seed() -> Result<QuestionnaireIndex, String> {
    let mut index = read_index()?;
    if !index.questionnaires.is_empty() {
        return Ok(index);
    }

    // Parse the embedded seed JSON
    let mut seed: QuestionnaireDefFile = serde_json::from_str(SEED_QUESTIONNAIRE_JSON)
        .map_err(|e| format!("Failed to parse seed questionnaire: {}", e))?;

    // Assign a fresh UUID
    let id = Uuid::new_v4().to_string();
    seed.id = id.clone();
    seed.version = 1;

    // Write the questionnaire file
    write_questionnaire(&seed)?;

    // Update the index
    let now = Utc::now();
    index.questionnaires.push(QuestionnaireIndexEntry {
        id: id.clone(),
        name: seed.name.clone(),
        version: 1,
        created_at: now,
        modified_at: now,
    });
    index.active_questionnaire_id = Some(id);
    write_index(&index)?;

    Ok(index)
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

/// Load the questionnaire index, creating the seed questionnaire on first run.
#[tauri::command]
pub fn load_questionnaire_index() -> Result<QuestionnaireIndex, String> {
    ensure_seed()
}

/// Load a single questionnaire definition by ID.
#[tauri::command]
pub fn load_questionnaire(id: String) -> Result<QuestionnaireDefFile, String> {
    read_questionnaire(&id)
}

/// Save/update a questionnaire definition. Bumps the version number.
#[tauri::command]
pub fn save_questionnaire(mut questionnaire: QuestionnaireDefFile) -> Result<(), String> {
    questionnaire.version += 1;
    write_questionnaire(&questionnaire)?;

    // Update the index entry
    let mut index = read_index()?;
    let now = Utc::now();
    if let Some(entry) = index
        .questionnaires
        .iter_mut()
        .find(|e| e.id == questionnaire.id)
    {
        entry.name = questionnaire.name.clone();
        entry.version = questionnaire.version;
        entry.modified_at = now;
    }
    write_index(&index)?;
    Ok(())
}

/// Create a new empty questionnaire with the given name.
#[tauri::command]
pub fn create_questionnaire(name: String) -> Result<QuestionnaireDefFile, String> {
    let id = Uuid::new_v4().to_string();
    let q = QuestionnaireDefFile {
        id: id.clone(),
        name: name.clone(),
        version: 1,
        tabs: vec![
            TabDef {
                id: "client-info".into(),
                label: "Client Info".into(),
            },
            TabDef {
                id: "contacts".into(),
                label: "Client Contacts".into(),
            },
            TabDef {
                id: "assignments".into(),
                label: "Assignments & Decisions".into(),
            },
        ],
        sections: vec![],
    };
    write_questionnaire(&q)?;

    let mut index = read_index()?;
    let now = Utc::now();
    index.questionnaires.push(QuestionnaireIndexEntry {
        id,
        name,
        version: 1,
        created_at: now,
        modified_at: now,
    });
    write_index(&index)?;

    Ok(q)
}

/// Duplicate an existing questionnaire with a new name.
#[tauri::command]
pub fn duplicate_questionnaire(id: String, name: String) -> Result<QuestionnaireDefFile, String> {
    let source = read_questionnaire(&id)?;
    let new_id = Uuid::new_v4().to_string();
    let q = QuestionnaireDefFile {
        id: new_id.clone(),
        name: name.clone(),
        version: 1,
        tabs: source.tabs,
        sections: source.sections,
    };
    write_questionnaire(&q)?;

    let mut index = read_index()?;
    let now = Utc::now();
    index.questionnaires.push(QuestionnaireIndexEntry {
        id: new_id,
        name,
        version: 1,
        created_at: now,
        modified_at: now,
    });
    write_index(&index)?;

    Ok(q)
}

/// Delete a questionnaire definition.
#[tauri::command]
pub fn delete_questionnaire(id: String) -> Result<(), String> {
    // Remove the file
    let path = questionnaire_path(&id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete questionnaire: {}", e))?;
    }

    // Update the index
    let mut index = read_index()?;
    index.questionnaires.retain(|e| e.id != id);
    if index.active_questionnaire_id.as_deref() == Some(&id) {
        // Fall back to the first remaining questionnaire, or None
        index.active_questionnaire_id = index.questionnaires.first().map(|e| e.id.clone());
    }
    write_index(&index)?;
    Ok(())
}

/// Set which questionnaire is the "active" one used for new clients.
#[tauri::command]
pub fn set_active_questionnaire(id: String) -> Result<(), String> {
    let mut index = read_index()?;
    // Verify the ID exists
    if !index.questionnaires.iter().any(|e| e.id == id) {
        return Err(format!("Questionnaire not found: {}", id));
    }
    index.active_questionnaire_id = Some(id);
    write_index(&index)?;
    Ok(())
}
