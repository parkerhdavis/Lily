use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::sidecar;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Info about a single logical variable extracted from the document.
/// Variables that differ only in case (e.g., "CLIENT NAME" vs "Client Name")
/// are grouped into one VariableInfo.
#[derive(Debug, Serialize)]
pub struct VariableInfo {
    /// Display name shown in the UI (the title-cased or first-seen variant).
    pub display_name: String,
    /// All distinct casings found in the document for this variable.
    pub variants: Vec<String>,
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

/// Copy a template .docx file to the working directory.
/// Records the template provenance in the directory's sidecar file.
/// Returns the path to the new copy.
#[tauri::command]
pub fn copy_template(
    template_path: String,
    dest_dir: String,
    filename: String,
    template_rel_path: String,
) -> Result<String, String> {
    let src = Path::new(&template_path);
    if !src.exists() {
        return Err(format!("Template file not found: {}", template_path));
    }

    let dest = Path::new(&dest_dir).join(&filename);
    fs::copy(src, &dest).map_err(|e| format!("Failed to copy template: {}", e))?;

    // Record template provenance in the sidecar file
    sidecar::record_document(&dest_dir, &filename, &template_rel_path)?;

    Ok(dest.to_string_lossy().to_string())
}

/// Rename a document file on disk and update its sidecar entry.
/// Returns the new full path.
#[tauri::command]
pub fn rename_document(docx_path: String, new_filename: String) -> Result<String, String> {
    let path = Path::new(&docx_path);
    let parent = path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let old_filename = path
        .file_name()
        .ok_or_else(|| "Cannot determine filename".to_string())?
        .to_string_lossy()
        .to_string();

    // Ensure the new filename ends with .docx
    let new_filename = if new_filename.ends_with(".docx") {
        new_filename
    } else {
        format!("{}.docx", new_filename)
    };

    let new_path = parent.join(&new_filename);

    if new_path.exists() {
        return Err(format!("A file named '{}' already exists", new_filename));
    }

    fs::rename(&docx_path, &new_path).map_err(|e| format!("Failed to rename document: {}", e))?;

    // Update the sidecar entry (best-effort)
    let working_dir = parent.to_string_lossy().to_string();
    if let Err(e) = sidecar::rename_document_entry(&working_dir, &old_filename, &new_filename) {
        eprintln!("Warning: failed to update sidecar after rename: {}", e);
    }

    Ok(new_path.to_string_lossy().to_string())
}

/// Extract all unique {Variable} placeholders from a .docx file.
/// Variables that differ only in case are grouped into one entry.
/// Returns a list of VariableInfo sorted by display name.
#[tauri::command]
pub fn extract_variables(docx_path: String) -> Result<Vec<VariableInfo>, String> {
    let xml_content = read_document_xml(&docx_path)?;
    let text = extract_text_from_xml(&xml_content);
    Ok(find_variables(&text))
}

/// Replace variables in a .docx file with the provided values.
/// The `variables` map is keyed by display_name (canonical form).
/// Each occurrence in the document is replaced with a case-matched version
/// of the value: ALL CAPS → uppercased, all lower → lowercased, otherwise as-is.
#[tauri::command]
pub fn replace_variables(
    docx_path: String,
    variables: HashMap<String, String>,
) -> Result<(), String> {
    // First, extract the variable info so we know all case variants
    let xml_content = read_document_xml(&docx_path)?;
    let text = extract_text_from_xml(&xml_content);
    let var_infos = find_variables(&text);

    // Build a map from each original-cased variant to the appropriately-cased value
    let mut replacement_map: HashMap<String, String> = HashMap::new();
    for info in &var_infos {
        if let Some(value) = variables.get(&info.display_name) {
            if value.is_empty() {
                continue;
            }
            for variant in &info.variants {
                let cased_value = apply_casing(value, variant);
                replacement_map.insert(variant.clone(), cased_value);
            }
        }
    }

    let file_bytes = fs::read(&docx_path).map_err(|e| format!("Failed to read docx: {}", e))?;

    let cursor = Cursor::new(&file_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open docx as zip: {}", e))?;

    // Read all entries from the archive
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read entry content: {}", e))?;
        entries.push((name, buf));
    }

    // Process and rewrite
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (name, content) in &entries {
            writer
                .start_file(name, options)
                .map_err(|e| format!("Failed to start zip entry: {}", e))?;

            if name == "word/document.xml"
                || name.starts_with("word/header")
                || name.starts_with("word/footer")
            {
                let xml_str = String::from_utf8_lossy(content);
                let replaced = replace_in_xml(&xml_str, &replacement_map);
                writer
                    .write_all(replaced.as_bytes())
                    .map_err(|e| format!("Failed to write entry: {}", e))?;
            } else {
                writer
                    .write_all(content)
                    .map_err(|e| format!("Failed to write entry: {}", e))?;
            }
        }

        writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    }

    fs::write(&docx_path, output.into_inner())
        .map_err(|e| format!("Failed to write docx: {}", e))?;

    // Update variable values in the sidecar file
    let path = Path::new(&docx_path);
    if let (Some(parent), Some(filename)) = (path.parent(), path.file_name()) {
        let working_dir = parent.to_string_lossy().to_string();
        let filename = filename.to_string_lossy().to_string();
        // Best-effort: don't fail the save if sidecar update fails
        if let Err(e) = sidecar::update_document_variables(&working_dir, &filename, variables) {
            eprintln!("Warning: failed to update sidecar: {}", e);
        }
    }

    Ok(())
}

/// Get an HTML representation of the .docx for preview purposes.
/// This extracts the text content with paragraph structure, preserving
/// variable placeholders for highlighting in the frontend.
#[tauri::command]
pub fn get_document_html(docx_path: String) -> Result<String, String> {
    let xml_content = read_document_xml(&docx_path)?;
    let html = xml_to_preview_html(&xml_content);
    Ok(html)
}

// ─── Internal helpers ───────────────────────────────────────────────────────

fn read_document_xml(docx_path: &str) -> Result<String, String> {
    let file_bytes = fs::read(docx_path).map_err(|e| format!("Failed to read docx: {}", e))?;
    let cursor = Cursor::new(file_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open docx as zip: {}", e))?;

    let mut document_xml = archive
        .by_name("word/document.xml")
        .map_err(|e| format!("Failed to find document.xml: {}", e))?;

    let mut content = String::new();
    document_xml
        .read_to_string(&mut content)
        .map_err(|e| format!("Failed to read document.xml: {}", e))?;

    Ok(content)
}

/// Extract plain text runs from Word XML.
/// Word often splits text across multiple <w:r>/<w:t> elements even within
/// a single logical string. We concatenate all <w:t> text within each
/// paragraph, then join paragraphs with newlines.
fn extract_text_from_xml(xml: &str) -> String {
    let mut result = String::new();
    let mut in_t = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement { name, .. }) => {
                if name.local_name == "t" {
                    in_t = true;
                } else if name.local_name == "p" && !result.is_empty() {
                    result.push('\n');
                }
            }
            Ok(xml::reader::XmlEvent::Characters(text)) => {
                if in_t {
                    result.push_str(&text);
                }
            }
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => {
                if name.local_name == "t" {
                    in_t = false;
                }
            }
            _ => {}
        }
    }

    result
}

/// Find all {Variable Name} patterns in text, grouping by case-insensitive key.
/// Returns a list of VariableInfo ordered by first appearance in the document.
fn find_variables(text: &str) -> Vec<VariableInfo> {
    // Preserves insertion order: each entry is (lowercased key, distinct original casings)
    let mut keys_in_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            let mut var_name = String::new();
            let mut found_close = false;
            for inner in chars.by_ref() {
                if inner == '}' {
                    found_close = true;
                    break;
                }
                var_name.push(inner);
            }
            if found_close && !var_name.is_empty() && !var_name.contains('{') {
                let trimmed = var_name.trim().to_string();
                let key = trimmed.to_lowercase();
                if !groups.contains_key(&key) {
                    keys_in_order.push(key.clone());
                }
                let variants = groups.entry(key).or_default();
                if !variants.contains(&trimmed) {
                    variants.push(trimmed);
                }
            }
        }
    }

    keys_in_order
        .into_iter()
        .filter_map(|key| {
            groups.remove(&key).map(|variants| {
                let display_name = pick_display_name(&variants);
                VariableInfo {
                    display_name,
                    variants,
                }
            })
        })
        .collect()
}

/// Choose the best display name from a set of case variants.
/// Prefers Title Case (e.g., "Client Full Name") over ALL CAPS or all lower.
/// Falls back to the first variant if no title-case variant is found.
fn pick_display_name(variants: &[String]) -> String {
    // Check for a "title case" variant (first letter of each word capitalized, rest lower)
    for v in variants {
        if is_title_case(v) {
            return v.clone();
        }
    }
    // Check for a "mixed case" variant (not all upper, not all lower)
    for v in variants {
        let has_upper = v.chars().any(|c| c.is_uppercase());
        let has_lower = v.chars().any(|c| c.is_lowercase());
        if has_upper && has_lower {
            return v.clone();
        }
    }
    // Fall back to first variant
    variants[0].clone()
}

fn is_title_case(s: &str) -> bool {
    for word in s.split_whitespace() {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            if !first.is_uppercase() {
                return false;
            }
            if chars.any(|c| c.is_uppercase()) {
                return false;
            }
        }
    }
    true
}

/// Apply the casing pattern of `original_var_name` to `value`.
/// - ALL CAPS → uppercase the value
/// - all lower → lowercase the value
/// - Otherwise (title case, mixed) → leave value as-is
fn apply_casing(value: &str, original_var_name: &str) -> String {
    let alpha_chars: Vec<char> = original_var_name
        .chars()
        .filter(|c| c.is_alphabetic())
        .collect();
    if alpha_chars.is_empty() {
        return value.to_string();
    }

    let all_upper = alpha_chars.iter().all(|c| c.is_uppercase());
    let all_lower = alpha_chars.iter().all(|c| c.is_lowercase());

    if all_upper {
        value.to_uppercase()
    } else if all_lower {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}

/// Replace {Variable} placeholders in raw XML content.
/// The `replacements` map goes from original-cased variable name to
/// the appropriately-cased replacement value.
fn replace_in_xml(xml: &str, replacements: &HashMap<String, String>) -> String {
    let mut result = xml.to_string();
    for (var_name, value) in replacements {
        let pattern = format!("{{{}}}", var_name);
        result = result.replace(&pattern, value);
    }
    result
}

/// Convert Word XML to a simple HTML preview.
/// Preserves paragraph structure, formatting, and highlights {Variable} placeholders.
/// The `data-variable` attribute uses a lowercase canonical key so the frontend
/// can match case-insensitively. The `data-original-case` attribute preserves
/// the original casing for case-appropriate replacement in the live preview.
fn xml_to_preview_html(xml: &str) -> String {
    let mut html = String::from("<div class=\"document-preview\">");
    let mut current_para = String::new();
    let mut in_t = false;
    let mut in_bold = false;
    let mut in_italic = false;
    let mut in_underline = false;
    let mut in_rpr = false;
    let mut pending_bold = false;
    let mut pending_italic = false;
    let mut pending_underline = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement {
                name, attributes, ..
            }) => {
                match name.local_name.as_str() {
                    "p" => {
                        current_para.clear();
                        in_bold = false;
                        in_italic = false;
                        in_underline = false;
                    }
                    "rPr" => {
                        in_rpr = true;
                        pending_bold = false;
                        pending_italic = false;
                        pending_underline = false;
                    }
                    "b" if in_rpr => {
                        // Check for w:val="false" or w:val="0"
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_bold = !disabled;
                    }
                    "i" if in_rpr => {
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_italic = !disabled;
                    }
                    "u" if in_rpr => {
                        let is_none = attributes
                            .iter()
                            .any(|a| a.name.local_name == "val" && a.value == "none");
                        pending_underline = !is_none;
                    }
                    "r" => {
                        // Reset formatting for new run (will be set by rPr if present)
                    }
                    "t" => {
                        in_t = true;
                    }
                    _ => {}
                }
            }
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => match name.local_name.as_str() {
                "rPr" => {
                    in_rpr = false;
                    in_bold = pending_bold;
                    in_italic = pending_italic;
                    in_underline = pending_underline;
                }
                "t" => {
                    in_t = false;
                }
                "p" => {
                    if current_para.is_empty() {
                        html.push_str("<p>&nbsp;</p>");
                    } else {
                        html.push_str("<p>");
                        html.push_str(&current_para);
                        html.push_str("</p>");
                    }
                }
                _ => {}
            },
            Ok(xml::reader::XmlEvent::Characters(text)) => {
                if in_t {
                    let escaped = escape_html(&text);
                    let highlighted = highlight_variables(&escaped);

                    let mut styled = highlighted;
                    if in_bold {
                        styled = format!("<strong>{}</strong>", styled);
                    }
                    if in_italic {
                        styled = format!("<em>{}</em>", styled);
                    }
                    if in_underline {
                        styled = format!("<u>{}</u>", styled);
                    }

                    current_para.push_str(&styled);
                }
            }
            _ => {}
        }
    }

    html.push_str("</div>");
    html
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Wrap {Variable} placeholders in highlight spans.
/// Uses lowercase `data-variable` for canonical matching and
/// `data-original-case` for the original casing seen in the document.
fn highlight_variables(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            let mut var_content = String::new();
            let mut found_close = false;
            for inner in chars.by_ref() {
                if inner == '}' {
                    found_close = true;
                    break;
                }
                var_content.push(inner);
            }
            if found_close && !var_content.is_empty() {
                let canonical = var_content.trim().to_lowercase();
                result.push_str(&format!(
                    "<span class=\"variable-highlight\" data-variable=\"{}\" data-original-case=\"{}\">{{{}}}</span>",
                    canonical, var_content, var_content
                ));
            } else {
                result.push('{');
                result.push_str(&var_content);
            }
        } else {
            result.push(c);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_variables_case_grouping() {
        let text = "Hello {Client Name} and {CLIENT NAME} and {client name}";
        let vars = find_variables(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].display_name, "Client Name");
        assert_eq!(vars[0].variants.len(), 3);
    }

    #[test]
    fn test_find_variables_display_name_prefers_title_case() {
        let text = "{CLIENT FULL NAME} and {Client Full Name}";
        let vars = find_variables(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].display_name, "Client Full Name");
    }

    #[test]
    fn test_apply_casing_all_upper() {
        assert_eq!(apply_casing("John Doe", "CLIENT NAME"), "JOHN DOE");
    }

    #[test]
    fn test_apply_casing_all_lower() {
        assert_eq!(apply_casing("John Doe", "client name"), "john doe");
    }

    #[test]
    fn test_apply_casing_title_case_passthrough() {
        assert_eq!(apply_casing("John Doe", "Client Name"), "John Doe");
    }

    #[test]
    fn test_highlight_variables_canonical_key() {
        let result = highlight_variables("{CLIENT NAME}");
        assert!(result.contains("data-variable=\"client name\""));
        assert!(result.contains("data-original-case=\"CLIENT NAME\""));
    }

    #[test]
    fn test_find_variables_ordered_by_appearance() {
        let text = "{Date} then {Client Name} then {Attorney Name}";
        let vars = find_variables(text);
        assert_eq!(vars.len(), 3);
        assert_eq!(vars[0].display_name, "Date");
        assert_eq!(vars[1].display_name, "Client Name");
        assert_eq!(vars[2].display_name, "Attorney Name");
    }
}
