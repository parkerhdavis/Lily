use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::lily_file;

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

    // Record template provenance in the .lily file
    lily_file::record_document(&dest_dir, &filename, &template_rel_path)?;

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

    // Update the .lily file entry (best-effort)
    let working_dir = parent.to_string_lossy().to_string();
    if let Err(e) = lily_file::rename_document_entry(&working_dir, &old_filename, &new_filename) {
        eprintln!("Warning: failed to update .lily file after rename: {}", e);
    }

    Ok(new_path.to_string_lossy().to_string())
}

/// Extract all unique variable references from a .docx file.
/// Performs a single pass through the XML, finding both `{Variable}`
/// placeholders in text AND Lily SDT content controls (`<w:sdt>` with
/// `lily:` tag prefix) from previous saves, in document order.
/// Variables that differ only in case are grouped into one entry.
#[tauri::command]
pub fn extract_variables(docx_path: String) -> Result<Vec<VariableInfo>, String> {
    let raw_xml = read_document_xml(&docx_path)?;
    let xml_content = normalize_split_variables(&raw_xml);
    Ok(find_all_variables(&xml_content))
}

/// Single-pass extraction of all variables from Word XML, in document order.
/// Finds both `{Placeholder}` patterns in `<w:t>` text and Lily SDT tags
/// (`<w:tag w:val="lily:..."/>`), interleaved in the order they appear.
fn find_all_variables(xml: &str) -> Vec<VariableInfo> {
    let mut keys_in_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();

    let mut in_t = false;
    let mut in_sdt = false;
    let mut in_sdt_pr = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement {
                name, attributes, ..
            }) => {
                match name.local_name.as_str() {
                    "t" => in_t = true,
                    "sdt" => in_sdt = true,
                    "sdtPr" if in_sdt => in_sdt_pr = true,
                    "tag" if in_sdt_pr => {
                        // Check for lily: prefix
                        for attr in &attributes {
                            if attr.name.local_name == "val"
                                && attr.value.starts_with(SDT_TAG_PREFIX)
                            {
                                let display_name = attr.value[SDT_TAG_PREFIX.len()..].to_string();
                                let key = display_name.to_lowercase();
                                if !groups.contains_key(&key) {
                                    keys_in_order.push(key.clone());
                                }
                                let variants = groups.entry(key).or_default();
                                if !variants.contains(&display_name) {
                                    variants.push(display_name);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => match name.local_name.as_str() {
                "t" => in_t = false,
                "sdt" => {
                    in_sdt = false;
                    in_sdt_pr = false;
                }
                "sdtPr" => in_sdt_pr = false,
                _ => {}
            },
            Ok(xml::reader::XmlEvent::Characters(text)) => {
                if in_t {
                    // Scan for {Variable} patterns in text content
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
                }
            }
            _ => {}
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

/// Replace variables in a .docx file with the provided values.
/// The `variables` map is keyed by display_name (canonical form).
///
/// For fresh `{Placeholder}` text: replaces the text and wraps it in an SDT
/// (Structured Document Tag / Content Control) with a `lily:VarName` tag so
/// the variable identity is preserved in the docx XML permanently.
///
/// For existing Lily SDTs (from a previous save): updates the text content
/// inside the SDT without creating a new wrapper.
///
/// Case-matching: ALL CAPS placeholders get uppercased values, all-lower get
/// lowercased, otherwise as-is.
#[tauri::command]
pub fn replace_variables(
    docx_path: String,
    variables: HashMap<String, String>,
) -> Result<(), String> {
    // First, extract the variable info so we know all case variants
    let raw_xml = read_document_xml(&docx_path)?;
    let xml_content = normalize_split_variables(&raw_xml);
    let text = extract_text_from_xml(&xml_content);
    let var_infos = find_variables(&text);

    // Build a map from each original-cased variant to (display_name, cased_value)
    // for fresh {Placeholder} replacement
    let mut placeholder_map: HashMap<String, (String, String)> = HashMap::new();
    for info in &var_infos {
        if let Some(value) = variables.get(&info.display_name) {
            if value.is_empty() {
                continue;
            }
            for variant in &info.variants {
                let cased_value = apply_casing(value, variant);
                placeholder_map.insert(variant.clone(), (info.display_name.clone(), cased_value));
            }
        }
    }

    // Build a map from display_name to value for SDT content updates
    let sdt_value_map: HashMap<String, String> = variables
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

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
                let normalized = normalize_split_variables(&xml_str);
                // First update any existing Lily SDTs
                let with_sdts_updated = update_sdt_values(&normalized, &sdt_value_map);
                // Then replace any remaining fresh {Placeholder} text with SDT-wrapped values
                let replaced = replace_placeholders_with_sdt(&with_sdts_updated, &placeholder_map);
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

    // Update variable values in the .lily file
    let path = Path::new(&docx_path);
    if let (Some(parent), Some(filename)) = (path.parent(), path.file_name()) {
        let working_dir = parent.to_string_lossy().to_string();
        let filename = filename.to_string_lossy().to_string();
        // Best-effort: don't fail the save if .lily file update fails
        if let Err(e) = lily_file::update_variables(&working_dir, &filename, variables) {
            eprintln!("Warning: failed to update .lily file: {}", e);
        }
    }

    Ok(())
}

/// Get an HTML representation of the .docx for preview purposes.
/// This extracts the text content with paragraph structure, preserving
/// variable placeholders for highlighting in the frontend.
#[tauri::command]
pub fn get_document_html(docx_path: String) -> Result<String, String> {
    let parts = read_docx_parts(&docx_path)?;
    let xml_content = normalize_split_variables(&parts.document);
    let numbering_map = parts
        .numbering
        .as_deref()
        .map(parse_numbering_xml)
        .unwrap_or_default();
    let style_map = parts
        .styles
        .as_deref()
        .map(parse_styles_xml)
        .unwrap_or_default();
    let html = xml_to_preview_html(&xml_content, &numbering_map, &style_map);
    Ok(html)
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/// Pre-process Word XML to merge variable placeholders that are split across
/// multiple `<w:r>` runs. Word often breaks `{Variable Name}` into separate
/// runs like `<w:t>{</w:t>...<w:t>Variable </w:t>...<w:t>Name}</w:t>`.
/// This function detects such splits and consolidates the text into a single
/// run so that downstream processing (highlight, replace) can see the full
/// `{Variable Name}` string in one `<w:t>` element.
///
/// The approach: find `<w:t ...>...{` where the `{` doesn't have a matching `}`
/// within the same `<w:t>`. Then scan forward to find the `}` in a subsequent
/// `<w:t>`, and merge all intermediate text into the first `<w:t>`.
fn normalize_split_variables(xml: &str) -> String {
    // This regex matches a <w:t> element that contains an unmatched opening brace.
    // We use a loop-based approach: find each `<w:t` element, extract text,
    // check for split variables, and merge if needed.

    // First, collect all <w:r>...</w:r> runs to work with structured data
    // Actually, let's use a simpler direct string approach:
    // Find each occurrence of `{` inside <w:t> text that doesn't have a matching `}`
    // in the same text node, then merge forward.

    let t_open_re = Regex::new(r#"<w:t(?: [^>]*)?>([^<]*)</w:t>"#).expect("invalid regex");

    let mut result = xml.to_string();
    let mut search_from = 0;

    loop {
        // Find the next <w:t> element from our search position
        let remaining = &result[search_from..];
        let Some(t_match) = t_open_re.find(remaining) else {
            break;
        };

        let abs_start = search_from + t_match.start();
        let abs_end = search_from + t_match.end();
        let full_tag = &result[abs_start..abs_end];

        // Extract the text content between <w:t...> and </w:t>
        let text_content = &t_open_re.captures(remaining).unwrap()[1];

        // Check if this text has an unmatched `{`
        let open_count = text_content.chars().filter(|&c| c == '{').count();
        let close_count = text_content.chars().filter(|&c| c == '}').count();

        if open_count <= close_count || !text_content.contains('{') {
            // No unmatched `{`, move on
            search_from = abs_end;
            continue;
        }

        // We have an unmatched `{`. Find the position of the last unmatched `{`
        // and collect text from subsequent <w:t> elements until we find the `}`
        let mut merged_text = text_content.to_string();
        let mut scan_pos = abs_end;
        let mut last_consumed_end = abs_end;
        let mut found_close = false;

        // We need to scan forward through subsequent runs to find `}`
        while scan_pos < result.len() {
            let scan_remaining = &result[scan_pos..];
            let Some(next_t) = t_open_re.find(scan_remaining) else {
                break;
            };

            let next_abs_start = scan_pos + next_t.start();
            let next_abs_end = scan_pos + next_t.end();

            // Check if there's a </w:r> and <w:r> between current and next <w:t>
            // (we only merge within the same paragraph — if we hit </w:p> stop)
            let between = &result[last_consumed_end..next_abs_start];
            if between.contains("</w:p>") {
                break;
            }

            let next_text = &t_open_re.captures(scan_remaining).unwrap()[1];
            merged_text.push_str(next_text);
            last_consumed_end = next_abs_end;

            if next_text.contains('}') {
                found_close = true;
                break;
            }

            scan_pos = next_abs_end;
        }

        if !found_close {
            // Couldn't find the closing `}`, skip this `{`
            search_from = abs_end;
            continue;
        }

        // Verify the merged text actually contains a valid {Variable} pattern
        let has_valid_var = {
            let mut found = false;
            let mut chars = merged_text.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '{' {
                    let mut name = String::new();
                    let mut closed = false;
                    for inner in chars.by_ref() {
                        if inner == '}' {
                            closed = true;
                            break;
                        }
                        name.push(inner);
                    }
                    if closed && !name.is_empty() && !name.contains('{') {
                        found = true;
                        break;
                    }
                }
            }
            found
        };

        if !has_valid_var {
            search_from = abs_end;
            continue;
        }

        // Build the replacement: keep the first <w:t>'s opening tag but with
        // the merged text, and remove the consumed subsequent <w:t> elements
        // by replacing the entire range from the first <w:t> to the last
        // consumed </w:t> end.

        // Extract the opening tag of the first <w:t> element (e.g., `<w:t xml:space="preserve">`)
        let opening_tag_end = full_tag.find('>').unwrap() + 1;
        let opening_tag = &full_tag[..opening_tag_end];

        // Build new element with merged text and xml:space="preserve"
        let new_opening = if opening_tag.contains("xml:space") {
            opening_tag.to_string()
        } else {
            opening_tag.replace("<w:t>", "<w:t xml:space=\"preserve\">")
        };

        // We need to replace the range from the start of the first <w:t> element
        // through the end of the last consumed element. But we can't just cut
        // the intermediate XML — we need to keep the <w:r> wrapper around our
        // merged text. The simplest correct approach: replace the text in the
        // first <w:t>, and blank out the text in subsequent consumed <w:t> elements.

        // Strategy: replace the entire span [abs_start..last_consumed_end] with:
        // 1. The first run's <w:r>...<w:t>MERGED_TEXT</w:t>...</w:r>
        // 2. The intermediate runs with their text emptied

        // Actually, the cleanest approach: just replace the text content in the
        // first <w:t> with the full merged text, and empty the intermediate <w:t> elements.

        let escaped_merged = escape_xml_text(&merged_text);
        let new_first_t = format!("{}{}</w:t>", new_opening, escaped_merged);

        // Replace the first <w:t>...</w:t>
        let mut new_xml = String::new();
        new_xml.push_str(&result[..abs_start]);
        new_xml.push_str(&new_first_t);

        // Now blank out all intermediate <w:t> elements between abs_end and last_consumed_end
        let mut intermediate = result[abs_end..last_consumed_end].to_string();
        intermediate = t_open_re
            .replace_all(&intermediate, |caps: &regex::Captures| {
                // Keep the tag but empty the text
                let full = caps.get(0).unwrap().as_str();
                let tag_end = full.find('>').unwrap() + 1;
                format!("{}</w:t>", &full[..tag_end])
            })
            .to_string();
        new_xml.push_str(&intermediate);

        new_xml.push_str(&result[last_consumed_end..]);

        let next_search = abs_start + new_first_t.len();
        result = new_xml;
        search_from = next_search;
    }

    result
}

/// Escape text for use in XML text content.
fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

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

/// Parts extracted from a .docx ZIP for preview rendering.
struct DocxParts {
    document: String,
    numbering: Option<String>,
    styles: Option<String>,
}

/// Read document.xml, numbering.xml, and styles.xml from a .docx ZIP.
fn read_docx_parts(docx_path: &str) -> Result<DocxParts, String> {
    let file_bytes = fs::read(docx_path).map_err(|e| format!("Failed to read docx: {}", e))?;
    let cursor = Cursor::new(file_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open docx as zip: {}", e))?;

    let document = {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("Failed to find document.xml: {}", e))?;
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read document.xml: {}", e))?;
        content
    };

    let numbering = match archive.by_name("word/numbering.xml") {
        Ok(mut entry) => {
            let mut content = String::new();
            entry.read_to_string(&mut content).ok();
            Some(content)
        }
        Err(_) => None,
    };

    let styles = match archive.by_name("word/styles.xml") {
        Ok(mut entry) => {
            let mut content = String::new();
            entry.read_to_string(&mut content).ok();
            Some(content)
        }
        Err(_) => None,
    };

    Ok(DocxParts {
        document,
        numbering,
        styles,
    })
}

// ─── Numbering / list support ───────────────────────────────────────────

/// Represents a single level within an abstract numbering definition.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct NumberingLevel {
    /// The number format: "decimal", "lowerLetter", "upperLetter",
    /// "lowerRoman", "upperRoman", "bullet", "none", etc.
    num_fmt: String,
    /// The level text pattern, e.g. "%1.", "%1.%2.", etc.
    lvl_text: String,
    /// Left indent in twips (1/20 of a point, 1440 = 1 inch).
    indent_left_twips: Option<i32>,
    /// Hanging indent in twips.
    indent_hanging_twips: Option<i32>,
}

/// Map from (numId, ilvl) to NumberingLevel.
type NumberingMap = HashMap<(String, String), NumberingLevel>;

/// Counters for active numbering sequences, keyed by (numId, ilvl).
type NumberingCounters = HashMap<(String, String), i32>;

/// Parse word/numbering.xml to extract numbering definitions.
///
/// Word numbering has two layers:
/// - `<w:abstractNum>` defines the format for each level
/// - `<w:num>` maps a numId to an abstractNumId
///
/// We flatten these into a direct (numId, ilvl) -> NumberingLevel map.
fn parse_numbering_xml(xml: &str) -> NumberingMap {
    let mut abstract_levels: HashMap<(String, String), NumberingLevel> = HashMap::new();
    let mut num_to_abstract: HashMap<String, String> = HashMap::new();

    // State for parsing
    let mut in_abstract_num = false;
    let mut current_abstract_id = String::new();
    let mut in_lvl = false;
    let mut current_lvl_ilvl = String::new();
    let mut current_num_fmt = String::new();
    let mut current_lvl_text = String::new();
    let mut current_indent_left: Option<i32> = None;
    let mut current_indent_hanging: Option<i32> = None;
    let mut in_num = false;
    let mut current_num_id = String::new();
    let mut in_ppr = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement {
                name, attributes, ..
            }) => match name.local_name.as_str() {
                "abstractNum" => {
                    in_abstract_num = true;
                    current_abstract_id = attributes
                        .iter()
                        .find(|a| a.name.local_name == "abstractNumId")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                }
                "lvl" if in_abstract_num => {
                    in_lvl = true;
                    current_lvl_ilvl = attributes
                        .iter()
                        .find(|a| a.name.local_name == "ilvl")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                    current_num_fmt = String::new();
                    current_lvl_text = String::new();
                    current_indent_left = None;
                    current_indent_hanging = None;
                    in_ppr = false;
                }
                "numFmt" if in_lvl => {
                    current_num_fmt = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                }
                "lvlText" if in_lvl => {
                    current_lvl_text = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                }
                "pPr" if in_lvl => {
                    in_ppr = true;
                }
                "ind" if in_lvl && in_ppr => {
                    for attr in &attributes {
                        match attr.name.local_name.as_str() {
                            "left" => current_indent_left = attr.value.parse().ok(),
                            "hanging" => current_indent_hanging = attr.value.parse().ok(),
                            _ => {}
                        }
                    }
                }
                "num" if !in_abstract_num => {
                    in_num = true;
                    current_num_id = attributes
                        .iter()
                        .find(|a| a.name.local_name == "numId")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                }
                "abstractNumId" if in_num => {
                    let abs_id = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                    num_to_abstract.insert(current_num_id.clone(), abs_id);
                }
                _ => {}
            },
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => match name.local_name.as_str() {
                "abstractNum" => {
                    in_abstract_num = false;
                }
                "lvl" if in_abstract_num => {
                    abstract_levels.insert(
                        (current_abstract_id.clone(), current_lvl_ilvl.clone()),
                        NumberingLevel {
                            num_fmt: current_num_fmt.clone(),
                            lvl_text: current_lvl_text.clone(),
                            indent_left_twips: current_indent_left,
                            indent_hanging_twips: current_indent_hanging,
                        },
                    );
                    in_lvl = false;
                    in_ppr = false;
                }
                "pPr" if in_lvl => {
                    in_ppr = false;
                }
                "num" => {
                    in_num = false;
                }
                _ => {}
            },
            _ => {}
        }
    }

    // Flatten: map (numId, ilvl) -> NumberingLevel via the num->abstractNum indirection
    let mut result = NumberingMap::new();
    for (num_id, abstract_id) in &num_to_abstract {
        // Collect all levels for this abstract num
        for ((abs_id, ilvl), level) in &abstract_levels {
            if abs_id == abstract_id {
                result.insert((num_id.clone(), ilvl.clone()), level.clone());
            }
        }
    }

    result
}

/// Format a number counter for a given numFmt.
fn format_number(counter: i32, num_fmt: &str) -> String {
    match num_fmt {
        "decimal" => counter.to_string(),
        "lowerLetter" => {
            if (1..=26).contains(&counter) {
                ((b'a' + (counter - 1) as u8) as char).to_string()
            } else {
                counter.to_string()
            }
        }
        "upperLetter" => {
            if (1..=26).contains(&counter) {
                ((b'A' + (counter - 1) as u8) as char).to_string()
            } else {
                counter.to_string()
            }
        }
        "lowerRoman" => to_roman(counter).to_lowercase(),
        "upperRoman" => to_roman(counter),
        _ => counter.to_string(),
    }
}

/// Convert an integer to Roman numerals (uppercase).
fn to_roman(mut n: i32) -> String {
    if n <= 0 || n > 3999 {
        return n.to_string();
    }
    let table = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut result = String::new();
    for (value, symbol) in table {
        while n >= value {
            result.push_str(symbol);
            n -= value;
        }
    }
    result
}

/// Build the displayed list label from a numbering level and counters.
/// Replaces `%1`, `%2`, etc. in the lvl_text pattern with actual counter values.
fn build_list_label(level: &NumberingLevel, num_id: &str, counters: &NumberingCounters) -> String {
    let mut label = level.lvl_text.clone();
    // Replace %1 through %9 with the counter for the corresponding level
    for lvl_idx in 0..9 {
        let placeholder = format!("%{}", lvl_idx + 1);
        if label.contains(&placeholder) {
            let ilvl_str = lvl_idx.to_string();
            let counter = counters
                .get(&(num_id.to_string(), ilvl_str))
                .copied()
                .unwrap_or(1);
            let formatted = format_number(counter, &level.num_fmt);
            label = label.replace(&placeholder, &formatted);
        }
    }
    label
}

// ─── Style support ──────────────────────────────────────────────────────

/// Resolved properties from a style definition.
#[derive(Debug, Clone, Default)]
struct StyleProps {
    /// Paragraph alignment (start/center/right/both/distribute).
    alignment: Option<String>,
    /// Bold.
    bold: Option<bool>,
    /// Italic.
    italic: Option<bool>,
    /// Underline.
    underline: Option<bool>,
    /// Font size in half-points.
    font_size_half_pts: Option<i32>,
    /// All caps.
    all_caps: Option<bool>,
    /// Small caps.
    small_caps: Option<bool>,
    /// Left indent in twips.
    indent_left_twips: Option<i32>,
    /// Right indent in twips.
    indent_right_twips: Option<i32>,
    /// First-line indent in twips (negative = hanging).
    indent_first_line_twips: Option<i32>,
    /// Spacing before in twips.
    spacing_before_twips: Option<i32>,
    /// Spacing after in twips.
    spacing_after_twips: Option<i32>,
    /// Line spacing in 240ths of a line.
    line_spacing_240ths: Option<i32>,
    /// The parent style ID, if any.
    based_on: Option<String>,
}

/// Map from style ID (e.g., "Heading1") to its properties.
type StyleMap = HashMap<String, StyleProps>;

/// Parse word/styles.xml to extract style definitions.
fn parse_styles_xml(xml: &str) -> StyleMap {
    let mut styles = StyleMap::new();

    let mut in_style = false;
    let mut current_style_id = String::new();
    let mut current_props = StyleProps::default();
    let mut in_ppr = false;
    let mut in_rpr = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement {
                name, attributes, ..
            }) => match name.local_name.as_str() {
                "style" => {
                    in_style = true;
                    current_style_id = attributes
                        .iter()
                        .find(|a| a.name.local_name == "styleId")
                        .map(|a| a.value.clone())
                        .unwrap_or_default();
                    current_props = StyleProps::default();
                }
                "basedOn" if in_style => {
                    current_props.based_on = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .map(|a| a.value.clone());
                }
                "pPr" if in_style => {
                    in_ppr = true;
                }
                "rPr" if in_style => {
                    in_rpr = true;
                }
                "jc" if in_ppr => {
                    current_props.alignment = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .map(|a| a.value.clone());
                }
                "ind" if in_ppr => {
                    for attr in &attributes {
                        match attr.name.local_name.as_str() {
                            "left" => {
                                current_props.indent_left_twips = attr.value.parse().ok();
                            }
                            "right" => {
                                current_props.indent_right_twips = attr.value.parse().ok();
                            }
                            "firstLine" => {
                                current_props.indent_first_line_twips = attr.value.parse().ok();
                            }
                            "hanging" => {
                                current_props.indent_first_line_twips =
                                    attr.value.parse::<i32>().ok().map(|v| -v);
                            }
                            _ => {}
                        }
                    }
                }
                "spacing" if in_ppr => {
                    for attr in &attributes {
                        match attr.name.local_name.as_str() {
                            "before" => {
                                current_props.spacing_before_twips = attr.value.parse().ok();
                            }
                            "after" => {
                                current_props.spacing_after_twips = attr.value.parse().ok();
                            }
                            "line" => {
                                current_props.line_spacing_240ths = attr.value.parse().ok();
                            }
                            _ => {}
                        }
                    }
                }
                "b" if in_rpr => {
                    let disabled = attributes.iter().any(|a| {
                        a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                    });
                    current_props.bold = Some(!disabled);
                }
                "i" if in_rpr => {
                    let disabled = attributes.iter().any(|a| {
                        a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                    });
                    current_props.italic = Some(!disabled);
                }
                "u" if in_rpr => {
                    let is_none = attributes
                        .iter()
                        .any(|a| a.name.local_name == "val" && a.value == "none");
                    current_props.underline = Some(!is_none);
                }
                "sz" if in_rpr => {
                    current_props.font_size_half_pts = attributes
                        .iter()
                        .find(|a| a.name.local_name == "val")
                        .and_then(|a| a.value.parse().ok());
                }
                "caps" if in_rpr => {
                    let disabled = attributes.iter().any(|a| {
                        a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                    });
                    current_props.all_caps = Some(!disabled);
                }
                "smallCaps" if in_rpr => {
                    let disabled = attributes.iter().any(|a| {
                        a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                    });
                    current_props.small_caps = Some(!disabled);
                }
                _ => {}
            },
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => match name.local_name.as_str() {
                "style" => {
                    if !current_style_id.is_empty() {
                        styles.insert(current_style_id.clone(), current_props.clone());
                    }
                    in_style = false;
                    in_ppr = false;
                    in_rpr = false;
                }
                "pPr" if in_style => {
                    in_ppr = false;
                }
                "rPr" if in_style => {
                    in_rpr = false;
                }
                _ => {}
            },
            _ => {}
        }
    }

    styles
}

/// Resolve a style by following the basedOn chain. Later (more specific)
/// properties override earlier (parent) ones.
fn resolve_style(style_id: &str, style_map: &StyleMap) -> StyleProps {
    let mut chain = Vec::new();
    let mut current = Some(style_id.to_string());
    let mut visited = std::collections::HashSet::new();

    while let Some(id) = current {
        if visited.contains(&id) {
            break; // Prevent infinite loops
        }
        visited.insert(id.clone());
        if let Some(props) = style_map.get(&id) {
            chain.push(props.clone());
            current = props.based_on.clone();
        } else {
            break;
        }
    }

    // Merge from parent to child (chain is child-first, so reverse)
    chain.reverse();
    let mut result = StyleProps::default();
    for props in chain {
        if props.alignment.is_some() {
            result.alignment = props.alignment;
        }
        if props.bold.is_some() {
            result.bold = props.bold;
        }
        if props.italic.is_some() {
            result.italic = props.italic;
        }
        if props.underline.is_some() {
            result.underline = props.underline;
        }
        if props.font_size_half_pts.is_some() {
            result.font_size_half_pts = props.font_size_half_pts;
        }
        if props.all_caps.is_some() {
            result.all_caps = props.all_caps;
        }
        if props.small_caps.is_some() {
            result.small_caps = props.small_caps;
        }
        if props.indent_left_twips.is_some() {
            result.indent_left_twips = props.indent_left_twips;
        }
        if props.indent_right_twips.is_some() {
            result.indent_right_twips = props.indent_right_twips;
        }
        if props.indent_first_line_twips.is_some() {
            result.indent_first_line_twips = props.indent_first_line_twips;
        }
        if props.spacing_before_twips.is_some() {
            result.spacing_before_twips = props.spacing_before_twips;
        }
        if props.spacing_after_twips.is_some() {
            result.spacing_after_twips = props.spacing_after_twips;
        }
        if props.line_spacing_240ths.is_some() {
            result.line_spacing_240ths = props.line_spacing_240ths;
        }
    }
    result
}

/// Convert twips to a CSS pt value (1 twip = 1/20 pt).
fn twips_to_pt(twips: i32) -> f64 {
    twips as f64 / 20.0
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

const SDT_TAG_PREFIX: &str = "lily:";

/// Find variable names from Lily SDT content controls in the XML.
/// Scans for `<w:tag w:val="lily:Variable Name"/>` inside `<w:sdtPr>` elements.
/// Returns a deduplicated list of display names in order of appearance.
#[cfg(test)]
fn find_sdt_variables(xml: &str) -> Vec<String> {
    let tag_re = Regex::new(r#"<w:tag\s+w:val="lily:([^"]*)"\s*/>"#).expect("invalid regex");
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for cap in tag_re.captures_iter(xml) {
        let name = cap[1].to_string();
        if seen.insert(name.to_lowercase()) {
            result.push(name);
        }
    }

    result
}

/// Replace `{Variable}` placeholders in raw XML with SDT-wrapped values.
/// Each `{VarName}` is replaced with a Content Control that preserves the
/// variable identity:
///
/// ```xml
/// <w:sdt>
///   <w:sdtPr><w:tag w:val="lily:Display Name"/><w:alias w:val="Display Name"/></w:sdtPr>
///   <w:sdtContent><w:r>...<w:t>value</w:t></w:r></w:sdtContent>
/// </w:sdt>
/// ```
///
/// The `replacements` map goes from original-cased variant to
/// (display_name, cased_value).
fn replace_placeholders_with_sdt(
    xml: &str,
    replacements: &HashMap<String, (String, String)>,
) -> String {
    if replacements.is_empty() {
        return xml.to_string();
    }

    // We need to find <w:r>...</w:r> runs that contain {Variable} text and
    // wrap them in SDTs. We use regex to find runs containing placeholders.
    let run_re = Regex::new(r#"<w:r\b[^>]*>.*?</w:r>"#).expect("invalid regex");
    let t_content_re = Regex::new(r#"<w:t(?: [^>]*)?>([^<]*)</w:t>"#).expect("invalid regex");
    let rpr_re = Regex::new(r#"<w:rPr>.*?</w:rPr>"#).expect("invalid regex");

    let mut result = String::new();
    let mut last_end = 0;

    for run_match in run_re.find_iter(xml) {
        let run_str = run_match.as_str();

        // Check if this run contains any {Variable} placeholder
        let mut has_replacement = false;
        if let Some(t_caps) = t_content_re.captures(run_str) {
            let text = &t_caps[1];
            for var_name in replacements.keys() {
                let pattern = format!("{{{}}}", var_name);
                if text.contains(&pattern) {
                    has_replacement = true;
                    break;
                }
            }
        }

        if !has_replacement {
            // No placeholder in this run, keep as-is
            result.push_str(&xml[last_end..run_match.end()]);
            last_end = run_match.end();
            continue;
        }

        // This run has placeholder(s). Replace text and wrap in SDT(s).
        // For simplicity, handle the common case: one placeholder per run.
        result.push_str(&xml[last_end..run_match.start()]);
        let rpr = rpr_re
            .find(run_str)
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        // Get the text content
        if let Some(t_caps) = t_content_re.captures(run_str) {
            let mut text = t_caps[1].to_string();
            let mut output_parts: Vec<String> = Vec::new();

            // Process each placeholder in the text
            loop {
                // Find the next {Variable} in the remaining text
                let mut found = false;
                for (var_name, (display_name, value)) in replacements {
                    let pattern = format!("{{{}}}", var_name);
                    if let Some(pos) = text.find(&pattern) {
                        // Text before the placeholder (as a plain run)
                        let before = &text[..pos];
                        if !before.is_empty() {
                            output_parts.push(format!(
                                "<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                                rpr,
                                escape_xml_text(before)
                            ));
                        }

                        // The SDT-wrapped replacement
                        let escaped_val = escape_xml_text(value);
                        let escaped_display = escape_xml_text(display_name);
                        output_parts.push(format!(
                            "<w:sdt><w:sdtPr><w:tag w:val=\"{}{}\"/><w:alias w:val=\"{}\"/></w:sdtPr><w:sdtContent><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:sdtContent></w:sdt>",
                            SDT_TAG_PREFIX, escaped_display, escaped_display, rpr, escaped_val
                        ));

                        // Continue with the text after the placeholder
                        text = text[pos + pattern.len()..].to_string();
                        found = true;
                        break;
                    }
                }

                if !found {
                    // No more placeholders; emit remaining text as a plain run
                    if !text.is_empty() {
                        output_parts.push(format!(
                            "<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                            rpr,
                            escape_xml_text(&text)
                        ));
                    }
                    break;
                }
            }

            for part in &output_parts {
                result.push_str(part);
            }
        } else {
            // No <w:t> found, keep the run as-is
            result.push_str(run_str);
        }

        last_end = run_match.end();
    }

    result.push_str(&xml[last_end..]);
    result
}

/// Update the text content inside existing Lily SDT content controls.
/// Finds each `<w:sdt>` with a `lily:` tag and replaces the `<w:t>` text
/// inside its `<w:sdtContent>` with the new value (applying appropriate casing).
fn update_sdt_values(xml: &str, values: &HashMap<String, String>) -> String {
    if values.is_empty() {
        return xml.to_string();
    }

    // Match entire SDT blocks: <w:sdt>...<w:tag w:val="lily:Name"/>...</w:sdt>
    let sdt_re = Regex::new(r#"<w:sdt>(.*?)</w:sdt>"#).expect("invalid regex");
    let tag_re = Regex::new(r#"<w:tag\s+w:val="lily:([^"]*)"\s*/>"#).expect("invalid regex");
    let t_re = Regex::new(r#"<w:t(?: [^>]*)?>([^<]*)</w:t>"#).expect("invalid regex");

    sdt_re
        .replace_all(xml, |caps: &regex::Captures| {
            let inner = &caps[1];

            // Extract the variable display name from the tag
            let Some(tag_caps) = tag_re.captures(inner) else {
                return caps[0].to_string();
            };
            let display_name = &tag_caps[1];

            // Look up the new value
            let Some(value) = values.get(display_name) else {
                return caps[0].to_string();
            };

            // Find the <w:t> inside sdtContent and get the original case from tag
            // For SDTs we use the display_name for casing (title case = as-is)
            let new_value = escape_xml_text(value);

            // Replace the text content inside the <w:t> element within sdtContent
            let new_inner = t_re
                .replace(inner, |t_caps: &regex::Captures| {
                    let full = t_caps[0].to_string();
                    let tag_end = full.find('>').unwrap() + 1;
                    format!("{}{}</w:t>", &full[..tag_end], new_value)
                })
                .to_string();

            format!("<w:sdt>{}</w:sdt>", new_inner)
        })
        .to_string()
}

/// Convert Word XML to an HTML preview with high-fidelity rendering.
/// Preserves paragraph structure, formatting, indentation, alignment,
/// tables, lists, tabs, line breaks, and highlights variables.
///
/// Handles two kinds of variables:
/// 1. Fresh `{Placeholder}` text — wrapped in highlight spans with
///    `data-variable` (lowercase canonical) and `data-original-case`.
/// 2. Lily SDT content controls — the text inside `<w:sdtContent>` is wrapped
///    in a highlight span using the `lily:` tag value as the variable name.
fn xml_to_preview_html(xml: &str, numbering_map: &NumberingMap, style_map: &StyleMap) -> String {
    let mut html = String::from("<div class=\"document-preview\">");
    let mut current_para = String::new();

    // Run-level formatting state
    let mut in_t = false;
    let mut in_bold = false;
    let mut in_italic = false;
    let mut in_underline = false;
    let mut in_strikethrough = false;
    let mut in_superscript = false;
    let mut in_subscript = false;
    let mut in_all_caps = false;
    let mut in_small_caps = false;
    let mut font_size_half_pts: Option<i32> = None;
    let mut font_color: Option<String> = None;
    let mut highlight_color: Option<String> = None;

    // Run properties parsing state
    let mut in_rpr = false;
    let mut pending_bold = false;
    let mut pending_italic = false;
    let mut pending_underline = false;
    let mut pending_strikethrough = false;
    let mut pending_superscript = false;
    let mut pending_subscript = false;
    let mut pending_all_caps = false;
    let mut pending_small_caps = false;
    let mut pending_font_size: Option<i32> = None;
    let mut pending_font_color: Option<String> = None;
    let mut pending_highlight_color: Option<String> = None;

    // Paragraph properties
    let mut in_ppr = false;
    let mut para_alignment: Option<String> = None;
    let mut para_indent_left_twips: Option<i32> = None;
    let mut para_indent_right_twips: Option<i32> = None;
    let mut para_indent_first_line_twips: Option<i32> = None;
    let mut para_spacing_before: Option<i32> = None;
    let mut para_spacing_after: Option<i32> = None;
    let mut para_line_spacing: Option<i32> = None;
    let mut para_style_id: Option<String> = None;
    let mut para_num_id: Option<String> = None;
    let mut para_ilvl: Option<String> = None;

    // SDT (structured document tag) state
    let mut in_sdt = false;
    let mut in_sdt_pr = false;
    let mut sdt_var_name: Option<String> = None;
    let mut in_sdt_content = false;

    // Table state
    let mut in_table = false;
    let mut in_tr = false;
    let mut in_tc = false;
    let mut tc_paras: Vec<String> = Vec::new();

    // Numbering counters — tracks the current count for each (numId, ilvl)
    let mut num_counters: NumberingCounters = HashMap::new();
    // Track the last numId we saw, to reset counters when sequences change
    let mut last_num_id: Option<String> = None;

    // Whether we're inside a pPr's numPr element
    let mut in_num_pr = false;

    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        match event {
            Ok(xml::reader::XmlEvent::StartElement {
                name, attributes, ..
            }) => {
                match name.local_name.as_str() {
                    // ─── Table elements ──────────────────────────────
                    "tbl" => {
                        in_table = true;
                        html.push_str("<table class=\"preview-table\">");
                    }
                    "tr" if in_table => {
                        in_tr = true;
                        html.push_str("<tr>");
                    }
                    "tc" if in_tr => {
                        in_tc = true;
                        tc_paras.clear();
                    }
                    // ─── Paragraph ───────────────────────────────────
                    "p" => {
                        current_para.clear();
                        in_bold = false;
                        in_italic = false;
                        in_underline = false;
                        in_strikethrough = false;
                        in_superscript = false;
                        in_subscript = false;
                        in_all_caps = false;
                        in_small_caps = false;
                        font_size_half_pts = None;
                        font_color = None;
                        highlight_color = None;
                        // Reset paragraph properties
                        para_alignment = None;
                        para_indent_left_twips = None;
                        para_indent_right_twips = None;
                        para_indent_first_line_twips = None;
                        para_spacing_before = None;
                        para_spacing_after = None;
                        para_line_spacing = None;
                        para_style_id = None;
                        para_num_id = None;
                        para_ilvl = None;
                    }
                    // ─── Paragraph properties ────────────────────────
                    "pPr" => {
                        in_ppr = true;
                    }
                    "pStyle" if in_ppr => {
                        para_style_id = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .map(|a| a.value.clone());
                    }
                    "jc" if in_ppr && !in_num_pr => {
                        para_alignment = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .map(|a| a.value.clone());
                    }
                    "ind" if in_ppr && !in_num_pr => {
                        for attr in &attributes {
                            match attr.name.local_name.as_str() {
                                "left" | "start" => {
                                    para_indent_left_twips = attr.value.parse().ok();
                                }
                                "right" | "end" => {
                                    para_indent_right_twips = attr.value.parse().ok();
                                }
                                "firstLine" => {
                                    para_indent_first_line_twips = attr.value.parse().ok();
                                }
                                "hanging" => {
                                    para_indent_first_line_twips =
                                        attr.value.parse::<i32>().ok().map(|v| -v);
                                }
                                _ => {}
                            }
                        }
                    }
                    "spacing" if in_ppr => {
                        for attr in &attributes {
                            match attr.name.local_name.as_str() {
                                "before" => {
                                    para_spacing_before = attr.value.parse().ok();
                                }
                                "after" => {
                                    para_spacing_after = attr.value.parse().ok();
                                }
                                "line" => {
                                    para_line_spacing = attr.value.parse().ok();
                                }
                                _ => {}
                            }
                        }
                    }
                    "numPr" if in_ppr => {
                        in_num_pr = true;
                    }
                    "ilvl" if in_num_pr => {
                        para_ilvl = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .map(|a| a.value.clone());
                    }
                    "numId" if in_num_pr => {
                        para_num_id = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .map(|a| a.value.clone());
                    }
                    // ─── SDT (structured document tag) ───────────────
                    "sdt" => {
                        in_sdt = true;
                        sdt_var_name = None;
                    }
                    "sdtPr" if in_sdt => {
                        in_sdt_pr = true;
                    }
                    "tag" if in_sdt_pr => {
                        for attr in &attributes {
                            if attr.name.local_name == "val"
                                && attr.value.starts_with(SDT_TAG_PREFIX)
                            {
                                sdt_var_name = Some(attr.value[SDT_TAG_PREFIX.len()..].to_string());
                            }
                        }
                    }
                    "sdtContent" if in_sdt => {
                        in_sdt_content = true;
                    }
                    // ─── Run properties ──────────────────────────────
                    "rPr" => {
                        in_rpr = true;
                        pending_bold = false;
                        pending_italic = false;
                        pending_underline = false;
                        pending_strikethrough = false;
                        pending_superscript = false;
                        pending_subscript = false;
                        pending_all_caps = false;
                        pending_small_caps = false;
                        pending_font_size = None;
                        pending_font_color = None;
                        pending_highlight_color = None;
                    }
                    "b" if in_rpr => {
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
                    "strike" if in_rpr => {
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_strikethrough = !disabled;
                    }
                    "dstrike" if in_rpr => {
                        // Treat double-strikethrough as regular strikethrough for preview
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_strikethrough = !disabled;
                    }
                    "vertAlign" if in_rpr => {
                        let val = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .map(|a| a.value.as_str());
                        match val {
                            Some("superscript") => {
                                pending_superscript = true;
                                pending_subscript = false;
                            }
                            Some("subscript") => {
                                pending_subscript = true;
                                pending_superscript = false;
                            }
                            _ => {
                                pending_superscript = false;
                                pending_subscript = false;
                            }
                        }
                    }
                    "caps" if in_rpr => {
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_all_caps = !disabled;
                    }
                    "smallCaps" if in_rpr => {
                        let disabled = attributes.iter().any(|a| {
                            a.name.local_name == "val" && (a.value == "false" || a.value == "0")
                        });
                        pending_small_caps = !disabled;
                    }
                    "sz" if in_rpr => {
                        pending_font_size = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .and_then(|a| a.value.parse().ok());
                    }
                    "color" if in_rpr => {
                        pending_font_color = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .filter(|a| a.value != "auto")
                            .map(|a| a.value.clone());
                    }
                    "highlight" if in_rpr => {
                        pending_highlight_color = attributes
                            .iter()
                            .find(|a| a.name.local_name == "val")
                            .filter(|a| a.value != "none")
                            .map(|a| word_highlight_to_css(&a.value));
                    }
                    // ─── Run start ───────────────────────────────────
                    "r" => {
                        // Reset formatting for new run (will be set by rPr if present)
                    }
                    // ─── Text content ────────────────────────────────
                    "t" => {
                        in_t = true;
                    }
                    // ─── Tab character ───────────────────────────────
                    "tab" => {
                        current_para.push_str("<span class=\"preview-tab\"></span>");
                    }
                    // ─── Line break ──────────────────────────────────
                    "br" => {
                        let br_type = attributes
                            .iter()
                            .find(|a| a.name.local_name == "type")
                            .map(|a| a.value.as_str());
                        match br_type {
                            Some("page") => {
                                current_para.push_str("<span class=\"preview-page-break\"></span>");
                            }
                            _ => {
                                current_para.push_str("<br>");
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(xml::reader::XmlEvent::EndElement { name, .. }) => match name.local_name.as_str() {
                // ─── Table end elements ──────────────────────────
                "tbl" => {
                    in_table = false;
                    html.push_str("</table>");
                }
                "tr" => {
                    in_tr = false;
                    html.push_str("</tr>");
                }
                "tc" => {
                    // Emit the cell with all its paragraphs
                    html.push_str("<td>");
                    for (i, para) in tc_paras.iter().enumerate() {
                        if i > 0 {
                            html.push_str("<br>");
                        }
                        html.push_str(para);
                    }
                    html.push_str("</td>");
                    in_tc = false;
                }
                // ─── SDT end elements ────────────────────────────
                "sdt" => {
                    in_sdt = false;
                    in_sdt_content = false;
                    sdt_var_name = None;
                }
                "sdtPr" => {
                    in_sdt_pr = false;
                }
                "sdtContent" => {
                    in_sdt_content = false;
                }
                // ─── Run properties end ──────────────────────────
                "rPr" => {
                    in_rpr = false;
                    in_bold = pending_bold;
                    in_italic = pending_italic;
                    in_underline = pending_underline;
                    in_strikethrough = pending_strikethrough;
                    in_superscript = pending_superscript;
                    in_subscript = pending_subscript;
                    in_all_caps = pending_all_caps;
                    in_small_caps = pending_small_caps;
                    font_size_half_pts = pending_font_size;
                    font_color = pending_font_color.clone();
                    highlight_color = pending_highlight_color.clone();
                }
                "t" => {
                    in_t = false;
                }
                "pPr" => {
                    in_ppr = false;
                    in_num_pr = false;
                }
                "numPr" => {
                    in_num_pr = false;
                }
                // ─── Paragraph end ───────────────────────────────
                "p" => {
                    // Resolve style-inherited properties
                    let style_props = para_style_id
                        .as_deref()
                        .map(|id| resolve_style(id, style_map))
                        .unwrap_or_default();

                    // Merge: explicit paragraph properties override style-inherited ones
                    let alignment = para_alignment
                        .as_deref()
                        .or(style_props.alignment.as_deref());
                    let indent_left = para_indent_left_twips.or(style_props.indent_left_twips);
                    let indent_right = para_indent_right_twips.or(style_props.indent_right_twips);
                    let indent_first =
                        para_indent_first_line_twips.or(style_props.indent_first_line_twips);
                    let spacing_before = para_spacing_before.or(style_props.spacing_before_twips);
                    let spacing_after = para_spacing_after.or(style_props.spacing_after_twips);
                    let line_spacing = para_line_spacing.or(style_props.line_spacing_240ths);

                    // Handle list numbering
                    let list_label = if let (Some(ref num_id), Some(ref ilvl)) =
                        (&para_num_id, &para_ilvl)
                    {
                        // numId "0" means "no list" (Word uses it to explicitly remove numbering)
                        if num_id != "0" {
                            if let Some(level) = numbering_map.get(&(num_id.clone(), ilvl.clone()))
                            {
                                // Reset counters for deeper levels when a shallower
                                // level is encountered, and when the numbering
                                // sequence changes
                                if last_num_id.as_ref() != Some(num_id) {
                                    // New numbering sequence
                                    last_num_id = Some(num_id.clone());
                                }

                                let ilvl_int: i32 = ilvl.parse().unwrap_or(0);

                                // Reset deeper level counters
                                for deeper in (ilvl_int + 1)..9 {
                                    num_counters.remove(&(num_id.clone(), deeper.to_string()));
                                }

                                // Increment counter for this level
                                let counter = num_counters
                                    .entry((num_id.clone(), ilvl.clone()))
                                    .or_insert(0);
                                *counter += 1;

                                if level.num_fmt == "bullet" {
                                    Some("\u{2022}".to_string())
                                } else if level.num_fmt == "none" {
                                    None
                                } else {
                                    Some(build_list_label(level, num_id, &num_counters))
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    // Build inline style
                    let mut styles = Vec::new();

                    // Indentation — for list items, use the numbering definition's
                    // indent if the paragraph doesn't specify its own
                    let effective_indent_left = if indent_left.is_some() {
                        indent_left
                    } else if let (Some(ref num_id), Some(ref ilvl)) = (&para_num_id, &para_ilvl) {
                        numbering_map
                            .get(&(num_id.clone(), ilvl.clone()))
                            .and_then(|l| l.indent_left_twips)
                    } else {
                        None
                    };

                    if let Some(left) = effective_indent_left {
                        if left != 0 {
                            styles.push(format!("padding-left:{:.1}pt", twips_to_pt(left)));
                        }
                    }
                    if let Some(right) = indent_right {
                        if right != 0 {
                            styles.push(format!("padding-right:{:.1}pt", twips_to_pt(right)));
                        }
                    }
                    if let Some(first) = indent_first {
                        if first != 0 {
                            styles.push(format!("text-indent:{:.1}pt", twips_to_pt(first)));
                        }
                    }

                    // Alignment
                    match alignment {
                        Some("center") => styles.push("text-align:center".to_string()),
                        Some("right") | Some("end") => {
                            styles.push("text-align:right".to_string());
                        }
                        Some("both") | Some("distribute") => {
                            styles.push("text-align:justify".to_string());
                        }
                        _ => {}
                    }

                    // Spacing
                    if let Some(before) = spacing_before {
                        if before != 0 {
                            styles.push(format!("margin-top:{:.1}pt", twips_to_pt(before)));
                        }
                    }
                    if let Some(after) = spacing_after {
                        // Use the explicit value even if 0, to override prose defaults
                        styles.push(format!("margin-bottom:{:.1}pt", twips_to_pt(after)));
                    }
                    if let Some(line) = line_spacing {
                        // Word line spacing is in 240ths of a line (240 = single, 480 = double)
                        let ratio = line as f64 / 240.0;
                        if (ratio - 1.0).abs() > 0.05 {
                            styles.push(format!("line-height:{:.2}", ratio));
                        }
                    }

                    // Font size from style (paragraph-level; runs override individually)
                    let style_font_size = style_props.font_size_half_pts;

                    // Build the opening tag
                    let style_attr = if styles.is_empty() {
                        String::new()
                    } else {
                        format!(" style=\"{}\"", styles.join(";"))
                    };

                    // Determine the HTML tag — use heading elements for heading styles
                    let heading_level = para_style_id.as_deref().and_then(detect_heading_level);

                    let tag = match heading_level {
                        Some(1) => "h1",
                        Some(2) => "h2",
                        Some(3) => "h3",
                        Some(4) => "h4",
                        Some(5) => "h5",
                        Some(6) => "h6",
                        _ => "p",
                    };

                    // Prepend list label if this is a list item
                    let mut para_content = String::new();
                    if let Some(ref label) = list_label {
                        para_content.push_str(&format!(
                            "<span class=\"preview-list-label\">{}\u{00a0}</span>",
                            escape_html(label)
                        ));
                    }

                    // Apply style-level bold/italic to runs that didn't specify their own
                    // This is handled in the text rendering below via style_props, but
                    // for paragraph-level font size we wrap content if needed
                    if let Some(sz) = style_font_size {
                        let pt = sz as f64 / 2.0;
                        // Only add font-size if it differs significantly from the
                        // default prose-sm size (~14px ≈ 10.5pt)
                        if !(9.0..=13.0).contains(&pt) {
                            para_content = format!(
                                "<span style=\"font-size:{:.1}pt\">{}</span>",
                                pt, current_para
                            );
                        } else {
                            para_content.push_str(&current_para);
                        }
                    } else {
                        para_content.push_str(&current_para);
                    }

                    if in_tc {
                        // Inside a table cell: collect paragraphs for later emission
                        if para_content.is_empty() {
                            tc_paras.push("&nbsp;".to_string());
                        } else {
                            tc_paras.push(para_content);
                        }
                    } else if para_content.is_empty() && list_label.is_none() {
                        html.push_str(&format!("<{}{}>", tag, style_attr));
                        html.push_str("&nbsp;");
                        html.push_str(&format!("</{}>", tag));
                    } else {
                        html.push_str(&format!("<{}{}>", tag, style_attr));
                        html.push_str(&para_content);
                        html.push_str(&format!("</{}>", tag));
                    }
                }
                _ => {}
            },
            Ok(xml::reader::XmlEvent::Characters(text)) => {
                if in_t {
                    let escaped = escape_html(&text);

                    // If we're inside a Lily SDT content, wrap in a variable span
                    let highlighted = if in_sdt_content {
                        if let Some(ref var_name) = sdt_var_name {
                            let canonical = var_name.to_lowercase();
                            format!(
                                "<span class=\"variable-highlight filled\" data-variable=\"{}\" data-original-case=\"{}\">{}</span>",
                                canonical, var_name, escaped
                            )
                        } else {
                            escaped
                        }
                    } else {
                        highlight_variables(&escaped)
                    };

                    // Apply run-level formatting
                    let mut styled = highlighted;

                    // Apply text transforms (caps/smallcaps) before wrapping in tags
                    if in_all_caps {
                        // All caps: uppercase the text content, but leave HTML tags alone
                        styled = uppercase_text_content(&styled);
                    } else if in_small_caps {
                        styled =
                            format!("<span style=\"font-variant:small-caps\">{}</span>", styled);
                    }

                    if in_bold {
                        styled = format!("<strong>{}</strong>", styled);
                    }
                    if in_italic {
                        styled = format!("<em>{}</em>", styled);
                    }
                    if in_underline {
                        styled = format!("<u>{}</u>", styled);
                    }
                    if in_strikethrough {
                        styled = format!("<s>{}</s>", styled);
                    }
                    if in_superscript {
                        styled = format!("<sup>{}</sup>", styled);
                    }
                    if in_subscript {
                        styled = format!("<sub>{}</sub>", styled);
                    }

                    // Build inline style for font size, color, highlight
                    let mut run_styles = Vec::new();
                    if let Some(sz) = font_size_half_pts {
                        let pt = sz as f64 / 2.0;
                        run_styles.push(format!("font-size:{:.1}pt", pt));
                    }
                    if let Some(ref color) = font_color {
                        run_styles.push(format!("color:#{}", color));
                    }
                    if let Some(ref bg) = highlight_color {
                        run_styles.push(format!("background-color:{}", bg));
                    }
                    if !run_styles.is_empty() {
                        styled =
                            format!("<span style=\"{}\">{}</span>", run_styles.join(";"), styled);
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

/// Detect heading level from a Word style ID.
/// Returns Some(1..6) for heading styles, None otherwise.
fn detect_heading_level(style_id: &str) -> Option<u8> {
    // Common Word style IDs: "Heading1", "Heading2", etc.
    let lower = style_id.to_lowercase();
    if let Some(rest) = lower.strip_prefix("heading") {
        rest.trim()
            .parse::<u8>()
            .ok()
            .filter(|n| (1..=6).contains(n))
    } else if let Some(rest) = lower.strip_prefix("titre") {
        // French Word
        rest.trim()
            .parse::<u8>()
            .ok()
            .filter(|n| (1..=6).contains(n))
    } else {
        None
    }
}

/// Convert a Word highlight color name to a CSS color value.
fn word_highlight_to_css(color: &str) -> String {
    match color {
        "yellow" => "#ffff00".to_string(),
        "green" => "#00ff00".to_string(),
        "cyan" => "#00ffff".to_string(),
        "magenta" => "#ff00ff".to_string(),
        "blue" => "#0000ff".to_string(),
        "red" => "#ff0000".to_string(),
        "darkBlue" => "#000080".to_string(),
        "darkCyan" => "#008080".to_string(),
        "darkGreen" => "#008000".to_string(),
        "darkMagenta" => "#800080".to_string(),
        "darkRed" => "#800000".to_string(),
        "darkYellow" => "#808000".to_string(),
        "darkGray" | "darkGrey" => "#808080".to_string(),
        "lightGray" | "lightGrey" => "#c0c0c0".to_string(),
        "black" => "#000000".to_string(),
        "white" => "#ffffff".to_string(),
        _ => format!("#{}", color), // Treat as hex if unknown
    }
}

/// Uppercase only the text content of an HTML string, leaving tags intact.
fn uppercase_text_content(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        if c == '<' {
            in_tag = true;
            result.push(c);
        } else if c == '>' {
            in_tag = false;
            result.push(c);
        } else if in_tag {
            result.push(c);
        } else {
            for uc in c.to_uppercase() {
                result.push(uc);
            }
        }
    }
    result
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

    #[test]
    fn test_normalize_split_variables_brace_in_separate_run() {
        // { and } are in separate runs from the variable name
        let xml = r#"<w:r><w:rPr><w:b/></w:rPr><w:t>{</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Agent #1 Full Name</w:t></w:r><w:r><w:rPr></w:rPr><w:t>}</w:t></w:r>"#;
        let normalized = normalize_split_variables(xml);
        assert!(
            normalized.contains("{Agent #1 Full Name}"),
            "Expected merged variable, got: {}",
            normalized
        );
    }

    #[test]
    fn test_normalize_split_variables_multi_split() {
        // Variable split across 3+ runs: { | Client | First Name }
        let xml = r#"<w:r><w:t>{</w:t></w:r><w:r><w:t>Client </w:t></w:r><w:r><w:t>First Name}</w:t></w:r>"#;
        let normalized = normalize_split_variables(xml);
        assert!(
            normalized.contains("{Client First Name}"),
            "Expected merged variable, got: {}",
            normalized
        );
    }

    #[test]
    fn test_normalize_preserves_non_split_variables() {
        // Variable already in a single run should be untouched
        let xml = r#"<w:r><w:t>{Client Name}</w:t></w:r>"#;
        let normalized = normalize_split_variables(xml);
        assert!(normalized.contains("{Client Name}"));
    }

    #[test]
    fn test_normalize_then_highlight() {
        // After normalization, highlight_variables should wrap the merged variable
        let xml = r#"<w:r><w:t>{</w:t></w:r><w:r><w:t>Test Var}</w:t></w:r>"#;
        let normalized = normalize_split_variables(xml);
        // The merged text should now contain the complete {Test Var}
        assert!(normalized.contains("{Test Var}"));
        // And highlight_variables should produce a proper span
        let highlighted = highlight_variables("{Test Var}");
        assert!(highlighted.contains("data-variable=\"test var\""));
    }

    // ─── SDT round-trip tests ───────────────────────────────────────────

    #[test]
    fn test_replace_placeholders_with_sdt() {
        let xml = r#"<w:r><w:rPr><w:b/></w:rPr><w:t>{Client Name}</w:t></w:r>"#;
        let mut replacements = HashMap::new();
        replacements.insert(
            "Client Name".to_string(),
            ("Client Name".to_string(), "Jane Doe".to_string()),
        );
        let result = replace_placeholders_with_sdt(xml, &replacements);
        assert!(
            result.contains("<w:sdt>"),
            "Expected SDT wrapper, got: {}",
            result
        );
        assert!(
            result.contains("w:val=\"lily:Client Name\""),
            "Expected lily tag, got: {}",
            result
        );
        assert!(
            result.contains("Jane Doe"),
            "Expected value, got: {}",
            result
        );
        // Formatting should be preserved inside the SDT run
        assert!(
            result.contains("<w:b/>"),
            "Expected bold preserved, got: {}",
            result
        );
    }

    #[test]
    fn test_find_sdt_variables() {
        let xml = r#"<w:sdt><w:sdtPr><w:tag w:val="lily:Client Name"/></w:sdtPr><w:sdtContent><w:r><w:t>Jane Doe</w:t></w:r></w:sdtContent></w:sdt>"#;
        let vars = find_sdt_variables(xml);
        assert_eq!(vars, vec!["Client Name"]);
    }

    #[test]
    fn test_find_sdt_variables_dedup() {
        let xml = r#"<w:sdt><w:sdtPr><w:tag w:val="lily:Name"/></w:sdtPr><w:sdtContent><w:r><w:t>A</w:t></w:r></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:tag w:val="lily:Name"/></w:sdtPr><w:sdtContent><w:r><w:t>B</w:t></w:r></w:sdtContent></w:sdt>"#;
        let vars = find_sdt_variables(xml);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0], "Name");
    }

    #[test]
    fn test_update_sdt_values() {
        let xml = r#"<w:sdt><w:sdtPr><w:tag w:val="lily:Client Name"/></w:sdtPr><w:sdtContent><w:r><w:t>Old Value</w:t></w:r></w:sdtContent></w:sdt>"#;
        let mut values = HashMap::new();
        values.insert("Client Name".to_string(), "New Value".to_string());
        let result = update_sdt_values(xml, &values);
        assert!(
            result.contains("New Value"),
            "Expected updated value, got: {}",
            result
        );
        assert!(
            !result.contains("Old Value"),
            "Old value should be gone, got: {}",
            result
        );
        assert!(
            result.contains("lily:Client Name"),
            "Tag should be preserved, got: {}",
            result
        );
    }

    #[test]
    fn test_sdt_roundtrip_extract() {
        // After saving with SDTs, extract_variables should find them via SDT tags
        let xml = r#"<w:sdt><w:sdtPr><w:tag w:val="lily:Phone Number"/><w:alias w:val="Phone Number"/></w:sdtPr><w:sdtContent><w:r><w:t>555-1234</w:t></w:r></w:sdtContent></w:sdt>"#;
        let vars = find_sdt_variables(xml);
        assert_eq!(vars, vec!["Phone Number"]);
    }

    #[test]
    fn test_sdt_preview_html() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        // Use a namespace-declared root so xml-rs can parse w: prefixed elements
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:sdt><w:sdtPr><w:tag w:val="lily:Client Name"/></w:sdtPr><w:sdtContent><w:r><w:t>Jane Doe</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("variable-highlight"),
            "Expected highlight span, got: {}",
            html
        );
        assert!(
            html.contains("data-variable=\"client name\""),
            "Expected canonical key, got: {}",
            html
        );
        assert!(
            html.contains("Jane Doe"),
            "Expected value text, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_paragraph_alignment() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Centered text</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("text-align:center"),
            "Expected center alignment, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_indentation() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>Indented text</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("padding-left:36.0pt"),
            "Expected left indent, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_tab_character() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Before</w:t></w:r><w:r><w:tab/><w:t>After</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("preview-tab"),
            "Expected tab span, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_line_break() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(html.contains("<br>"), "Expected line break, got: {}", html);
    }

    #[test]
    fn test_preview_table() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("<table"),
            "Expected table element, got: {}",
            html
        );
        assert!(
            html.contains("<td>Cell 1</td>"),
            "Expected cell content, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_strikethrough() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>struck</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("<s>struck</s>"),
            "Expected strikethrough, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_superscript() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>th</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("<sup>th</sup>"),
            "Expected superscript, got: {}",
            html
        );
    }

    #[test]
    fn test_preview_font_size() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="36"/></w:rPr><w:t>big</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(
            html.contains("font-size:18.0pt"),
            "Expected 18pt font size (36 half-pts), got: {}",
            html
        );
    }

    #[test]
    fn test_preview_heading_style() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles);
        assert!(html.contains("<h1"), "Expected h1 element, got: {}", html);
    }
}
