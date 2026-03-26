use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use tracing::{error, info};

use crate::lily_file;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Info about a single logical variable extracted from the document.
/// Variables that differ only in case (e.g., "CLIENT NAME" vs "Client Name")
/// are grouped into one VariableInfo.
#[derive(Debug, Serialize)]
pub struct VariableInfo {
    /// Display name shown in the UI (the title-cased or first-seen variant).
    /// For conditional variables, this is the label portion before the `??`.
    pub display_name: String,
    /// All distinct casings found in the document for this variable.
    pub variants: Vec<String>,
    /// Whether this is a conditional (ternary) variable.
    /// Conditional variables use the syntax `{Label ?? true_text :: false_text}`
    /// and display as a checkbox in the UI.
    pub is_conditional: bool,
}

// ─── Template schema types ──────────────────────────────────────────────────

/// Schema definition for a single variable in a template.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VariableSchemaEntry {
    /// The type of this variable: "text", "date", "currency", or "conditional".
    #[serde(default = "default_var_type")]
    pub var_type: String,
    /// Default value if the user hasn't provided one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Help text shown to the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// Date format string (for date variables, e.g., "MM/DD/YYYY").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_format: Option<String>,
    /// Whether this field is required.
    #[serde(default)]
    pub required: bool,
}

fn default_var_type() -> String {
    "text".to_string()
}

/// Schema file for a template — stored as a .lily sidecar file alongside the template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableSchema {
    /// Identifies this as a template schema file.
    pub lily_type: String,
    /// The template filename this schema applies to.
    pub template_filename: String,
    /// Map from variable display_name to its schema definition.
    #[serde(default)]
    pub variables: HashMap<String, VariableSchemaEntry>,
}

impl Default for VariableSchema {
    fn default() -> Self {
        Self {
            lily_type: "template-schema".to_string(),
            template_filename: String::new(),
            variables: HashMap::new(),
        }
    }
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
    info!(%template_path, %filename, "Copying template");
    let src = Path::new(&template_path);
    if !src.exists() {
        error!(%template_path, "Template file not found");
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
/// Finds `{Placeholder}` patterns in `<w:t>` text, Lily SDT tags
/// (`<w:tag w:val="lily:..."/>`), and Lily bookmarks
/// (`<w:bookmarkStart w:name="lily:..."/>`), interleaved in the order they appear.
fn find_all_variables(xml: &str) -> Vec<VariableInfo> {
    let mut keys_in_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    // Track which keys are conditional variables (contain `??`).
    let mut conditional_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

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
                        // Check for lily: prefix in SDT tags
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
                    "bookmarkStart" => {
                        // Check for lily: prefix in bookmark names
                        for attr in &attributes {
                            if attr.name.local_name == "name"
                                && attr.value.starts_with(BOOKMARK_PREFIX)
                            {
                                let display_name = attr.value[BOOKMARK_PREFIX.len()..].to_string();
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
                    // Scan for {Variable} patterns in text content, with
                    // brace-depth tracking to support nested variables inside
                    // conditional branches.
                    let mut chars = text.chars().peekable();
                    while let Some(c) = chars.next() {
                        if c == '{' {
                            if let Some(var_name) = scan_brace_content(&mut chars) {
                                if var_name.is_empty() {
                                    continue;
                                }
                                let trimmed = var_name.trim().to_string();
                                // For conditional variables, use the label as the key
                                if is_conditional_variable(&trimmed) {
                                    if let Some((label, true_text, false_text)) =
                                        parse_conditional_variable(&trimmed)
                                    {
                                        let key = label.to_lowercase();
                                        conditional_keys.insert(key.clone());
                                        if !groups.contains_key(&key) {
                                            keys_in_order.push(key.clone());
                                        }
                                        let variants = groups.entry(key).or_default();
                                        if !variants.contains(&trimmed) {
                                            variants.push(trimmed);
                                        }

                                        // Also register any nested replacement
                                        // variables found inside the true/false branches
                                        for branch in [&true_text, &false_text] {
                                            for nested in extract_nested_variables(branch) {
                                                let nkey = if let Some((role, property)) =
                                                    parse_contact_role_ref(&nested)
                                                {
                                                    contact_role_to_flat_name(&role, &property)
                                                        .to_lowercase()
                                                } else {
                                                    nested.to_lowercase()
                                                };
                                                if !groups.contains_key(&nkey) {
                                                    keys_in_order.push(nkey.clone());
                                                }
                                                let nvariants = groups.entry(nkey).or_default();
                                                if !nvariants.contains(&nested) {
                                                    nvariants.push(nested);
                                                }
                                            }
                                        }
                                    }
                                } else if !trimmed.contains('{') {
                                    // Check for contact-role dot notation
                                    // (e.g., "Healthcare POA Agent.full_name")
                                    let key = if let Some((role, property)) =
                                        parse_contact_role_ref(&trimmed)
                                    {
                                        contact_role_to_flat_name(&role, &property).to_lowercase()
                                    } else {
                                        trimmed.to_lowercase()
                                    };
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
            }
            _ => {}
        }
    }

    keys_in_order
        .into_iter()
        .filter_map(|key| {
            groups.remove(&key).map(|variants| {
                let is_conditional = conditional_keys.contains(&key);
                let display_name = if is_conditional {
                    // For conditional variables, derive display name from the label part
                    let raw = &variants[0];
                    parse_conditional_variable(raw)
                        .map(|(label, _, _)| label)
                        .unwrap_or_else(|| pick_display_name(&variants))
                } else if let Some((role, property)) = variants
                    .iter()
                    .find_map(|v| parse_contact_role_ref(v))
                {
                    // Contact-role dot notation → flat display name
                    contact_role_to_flat_name(&role, &property)
                } else {
                    pick_display_name(&variants)
                };
                VariableInfo {
                    display_name,
                    variants,
                    is_conditional,
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
    conditional_definitions: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    info!(%docx_path, var_count = variables.len(), "Replacing variables in document");
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
            if info.is_conditional {
                // For conditional variables, resolve the true/false text.
                // The stored value is "true" or "false".
                let is_true = value == "true";
                for variant in &info.variants {
                    if let Some((label, true_text, false_text)) =
                        parse_conditional_variable(variant)
                    {
                        let branch = if is_true { true_text } else { false_text };
                        // Resolve any nested {Var} references within the branch
                        let resolved = resolve_nested_variables(&branch, &variables);
                        // Use the label as the display_name for the SDT tag
                        placeholder_map.insert(variant.clone(), (label, resolved));
                    }
                }
            } else {
                if value.is_empty() {
                    continue;
                }
                for variant in &info.variants {
                    let cased_value = apply_casing(value, variant);
                    placeholder_map
                        .insert(variant.clone(), (info.display_name.clone(), cased_value));
                }
            }
        }
    }

    // Build a map from display_name to value for SDT/bookmark content updates.
    // This includes ALL variables the caller provides, not just the ones
    // found in fresh {Placeholder} text. After the first save, conditional
    // variables exist only as SDTs/bookmarks (not as {Placeholder} text),
    // so they won't appear in var_infos but still need to be in this map.
    // The branch resolution for conditionals happens inside
    // update_sdt_and_bookmark_values using the definition from the SDT tag.
    let mut sdt_value_map: HashMap<String, String> = HashMap::new();
    for (name, value) in &variables {
        if !value.is_empty() {
            sdt_value_map.insert(name.clone(), value.clone());
        }
    }
    // Also pass the full variables map so conditionals with nested
    // {Var} references can be resolved during SDT/bookmark updates.
    let all_variables = variables.clone();

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

    // If the output file is .docx, ensure [Content_Types].xml declares the
    // main document part with the document (not template) content type.
    // Templates (.dotx) use "...template.main+xml" while documents (.docx)
    // must use "...document.main+xml".  When a template is copied and saved
    // as a .docx, the original template content type would cause Word to
    // reject the file as corrupt.
    let is_docx = docx_path.to_lowercase().ends_with(".docx");

    // Process and rewrite
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Find the max ID used by bookmarks and SDTs across all XML parts
        // so we can generate unique IDs for any new lily bookmarks and SDTs.
        let mut next_id: u64 = entries
            .iter()
            .filter(|(name, _)| {
                name == "word/document.xml"
                    || name.starts_with("word/header")
                    || name.starts_with("word/footer")
            })
            .map(|(_, content)| {
                let xml_str = String::from_utf8_lossy(content);
                find_max_id(&xml_str)
            })
            .max()
            .unwrap_or(0)
            + 1;

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
                // First update any existing Lily SDTs and bookmarks
                let with_markers_updated = update_sdt_and_bookmark_values(
                    &normalized,
                    &sdt_value_map,
                    &all_variables,
                    &conditional_definitions,
                    &mut next_id,
                );
                // Then replace any remaining fresh {Placeholder} text with SDT-wrapped values
                let replaced = replace_placeholders_with_sdt(
                    &with_markers_updated,
                    &placeholder_map,
                    &mut next_id,
                );
                writer
                    .write_all(replaced.as_bytes())
                    .map_err(|e| format!("Failed to write entry: {}", e))?;
            } else if name == "[Content_Types].xml" && is_docx {
                // Patch the content type so Word recognises the file as a
                // document rather than a template.
                let ct_xml = String::from_utf8_lossy(content);
                let patched = ct_xml.replace(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                );
                writer
                    .write_all(patched.as_bytes())
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
    let rels_map = parts
        .rels
        .as_deref()
        .map(parse_rels_xml)
        .unwrap_or_default();
    let html = xml_to_preview_html(&xml_content, &numbering_map, &style_map, &rels_map);
    Ok(html)
}

// ─── Template authoring commands ────────────────────────────────────────────

/// A single occurrence of text found in a template document.
#[derive(Debug, Serialize)]
pub struct TextOccurrence {
    /// Zero-based index of this occurrence in document order.
    pub index: usize,
    /// Surrounding context (~40 chars on each side).
    pub context: String,
    /// One-based paragraph number where this occurrence appears.
    pub paragraph_number: usize,
}

/// A segment of text within a paragraph, mapping flat-text offsets to XML byte ranges.
struct TextSegment {
    /// Byte offset in the XML where the <w:t> content starts.
    xml_content_start: usize,
    /// Byte offset in the XML where the <w:t> content ends.
    xml_content_end: usize,
    /// Character offset in the concatenated paragraph text where this segment starts.
    text_start: usize,
    /// Character offset in the concatenated paragraph text where this segment ends.
    text_end: usize,
}

/// A paragraph with its text segments and flat text.
struct ParagraphTextMap {
    /// The concatenated plain text of this paragraph.
    flat_text: String,
    /// Segments mapping flat text ranges back to XML byte ranges.
    segments: Vec<TextSegment>,
    /// One-based paragraph number.
    paragraph_number: usize,
}

/// Build a text-to-XML mapping for all paragraphs in the document XML.
/// This maps flat text positions back to specific byte ranges in the XML,
/// enabling text search in the flat text with replacement in the XML.
fn build_paragraph_text_maps(xml: &str) -> Vec<ParagraphTextMap> {
    let t_re = Regex::new(r#"<w:t(?: [^>]*)?>([^<]*)</w:t>"#).expect("invalid regex");
    let p_start_re = Regex::new(r#"<w:p[\s>/]"#).expect("invalid regex");
    let p_end_re = Regex::new(r#"</w:p>"#).expect("invalid regex");

    let mut maps = Vec::new();
    let mut para_num: usize = 0;

    // Find paragraph boundaries
    let mut search_from = 0;
    while let Some(p_start) = p_start_re.find(&xml[search_from..]) {
        let para_start = search_from + p_start.start();
        para_num += 1;

        // Find the end of this paragraph
        let after_start = para_start + p_start.len();
        let para_end = match p_end_re.find(&xml[after_start..]) {
            Some(m) => after_start + m.end(),
            None => {
                search_from = after_start;
                continue;
            }
        };

        let para_xml = &xml[para_start..para_end];
        let mut flat_text = String::new();
        let mut segments = Vec::new();

        // Find all <w:t> elements within this paragraph
        for t_match in t_re.captures_iter(para_xml) {
            let content = t_match.get(1).unwrap();

            let xml_content_start = para_start + content.start();
            let xml_content_end = para_start + content.end();
            let text_start = flat_text.len();
            // Decode XML entities for the flat text
            let decoded = content.as_str()
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");
            flat_text.push_str(&decoded);
            let text_end = flat_text.len();

            segments.push(TextSegment {
                xml_content_start,
                xml_content_end,
                text_start,
                text_end,
            });
        }

        if !flat_text.is_empty() {
            maps.push(ParagraphTextMap {
                flat_text,
                segments,
                paragraph_number: para_num,
            });
        }

        search_from = para_end;
    }

    maps
}

/// Find all occurrences of `search_text` across the document paragraphs.
/// Returns (paragraph_index, char_offset_in_flat_text) pairs.
fn find_text_in_paragraphs(
    maps: &[ParagraphTextMap],
    search_text: &str,
) -> Vec<(usize, usize)> {
    let mut results = Vec::new();
    for (pi, para) in maps.iter().enumerate() {
        let mut start = 0;
        while let Some(pos) = para.flat_text[start..].find(search_text) {
            results.push((pi, start + pos));
            start += pos + 1;
        }
    }
    results
}

/// Replace text at a specific position in the XML, handling cross-segment spans.
/// Returns the modified XML string.
fn replace_text_in_xml(
    xml: &str,
    para: &ParagraphTextMap,
    text_offset: usize,
    search_len: usize,
    replacement: &str,
) -> String {
    let text_end = text_offset + search_len;

    // Find which segments this match spans
    let mut first_seg: Option<usize> = None;
    let mut last_seg: Option<usize> = None;

    for (i, seg) in para.segments.iter().enumerate() {
        if seg.text_end > text_offset && seg.text_start < text_end {
            if first_seg.is_none() {
                first_seg = Some(i);
            }
            last_seg = Some(i);
        }
    }

    let Some(first) = first_seg else {
        return xml.to_string();
    };
    let last = last_seg.unwrap_or(first);

    let mut result = xml.to_string();

    // Work backwards to preserve byte offsets
    if first == last {
        // Match is within a single segment — simple substring replacement
        let seg = &para.segments[first];
        let seg_text_start = text_offset - seg.text_start;
        let seg_text_end = text_end - seg.text_start;
        let original_content = &xml[seg.xml_content_start..seg.xml_content_end];
        // Decode, replace, re-encode
        let decoded = original_content
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'");
        let new_decoded = format!(
            "{}{}{}",
            &decoded[..seg_text_start],
            replacement,
            &decoded[seg_text_end..],
        );
        let new_encoded = escape_xml_text(&new_decoded);
        result.replace_range(seg.xml_content_start..seg.xml_content_end, &new_encoded);
    } else {
        // Match spans multiple segments — put replacement in first, blank others
        // Process in reverse order to preserve byte offsets
        for i in (first + 1..=last).rev() {
            let seg = &para.segments[i];
            let keep_start = if i == last {
                text_end - seg.text_start
            } else {
                seg.text_end - seg.text_start
            };
            let original_content = &result[seg.xml_content_start..seg.xml_content_end];
            let decoded = original_content
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");
            let remaining = if i == last {
                &decoded[keep_start..]
            } else {
                ""
            };
            result.replace_range(
                seg.xml_content_start..seg.xml_content_end,
                &escape_xml_text(remaining),
            );
        }
        // Now handle the first segment
        let seg = &para.segments[first];
        let seg_text_start = text_offset - seg.text_start;
        let original_content = &result[seg.xml_content_start..seg.xml_content_end];
        let decoded = original_content
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'");
        let new_decoded = format!("{}{}", &decoded[..seg_text_start], replacement);
        result.replace_range(
            seg.xml_content_start..seg.xml_content_end,
            &escape_xml_text(&new_decoded),
        );
    }

    result
}

/// Find all occurrences of text in a template document, with context for disambiguation.
#[tauri::command]
pub fn get_template_text_occurrences(
    template_path: String,
    search_text: String,
) -> Result<Vec<TextOccurrence>, String> {
    info!(%template_path, %search_text, "Finding text occurrences in template");
    let xml = read_document_xml(&template_path)?;
    let normalized = normalize_split_variables(&xml);
    let maps = build_paragraph_text_maps(&normalized);
    let matches = find_text_in_paragraphs(&maps, &search_text);

    let mut occurrences = Vec::new();
    for (i, (pi, offset)) in matches.iter().enumerate() {
        let para = &maps[*pi];
        let end = offset + search_text.len();
        // Build context: ~20 chars before and after
        let ctx_start = offset.saturating_sub(20);
        let ctx_end = (end + 20).min(para.flat_text.len());
        let mut context = String::new();
        if ctx_start > 0 {
            context.push_str("...");
        }
        context.push_str(&para.flat_text[ctx_start..ctx_end]);
        if ctx_end < para.flat_text.len() {
            context.push_str("...");
        }

        occurrences.push(TextOccurrence {
            index: i,
            context,
            paragraph_number: para.paragraph_number,
        });
    }

    Ok(occurrences)
}

/// Replace text in a template with a `{Variable Name}` placeholder.
/// Returns the updated list of variables in the template.
#[tauri::command]
pub fn insert_template_variable(
    template_path: String,
    search_text: String,
    variable_name: String,
    occurrence_index: Option<usize>,
    replace_all: Option<bool>,
) -> Result<Vec<VariableInfo>, String> {
    info!(%template_path, %search_text, %variable_name, "Inserting template variable");

    let file_bytes =
        fs::read(&template_path).map_err(|e| format!("Failed to read docx: {}", e))?;
    let cursor = Cursor::new(file_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open docx as zip: {}", e))?;

    // Read all entries
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

    let replacement = format!("{{{}}}", variable_name);

    // Process document.xml (and optionally headers/footers)
    for (name, content) in entries.iter_mut() {
        if name != "word/document.xml"
            && !name.starts_with("word/header")
            && !name.starts_with("word/footer")
        {
            continue;
        }

        let xml_str = String::from_utf8_lossy(content).to_string();
        let normalized = normalize_split_variables(&xml_str);
        let maps = build_paragraph_text_maps(&normalized);
        let matches = find_text_in_paragraphs(&maps, &search_text);

        if matches.is_empty() {
            continue;
        }

        let replace_all = replace_all.unwrap_or(false);

        if matches.len() > 1 && !replace_all && occurrence_index.is_none() {
            return Err(format!(
                "Found {} occurrences of \"{}\". Specify occurrence_index or use replace_all.",
                matches.len(),
                search_text
            ));
        }

        // Determine which matches to replace
        let to_replace: Vec<(usize, usize)> = if replace_all {
            matches
        } else if let Some(idx) = occurrence_index {
            if idx >= matches.len() {
                return Err(format!(
                    "Occurrence index {} out of range (found {})",
                    idx,
                    matches.len()
                ));
            }
            vec![matches[idx]]
        } else {
            vec![matches[0]]
        };

        // Replace one match at a time, re-finding after each replacement
        // because replacing text can shift paragraph indices and byte offsets.
        let mut modified = normalized;
        let replace_count = to_replace.len();

        for _ in 0..replace_count {
            let maps = build_paragraph_text_maps(&modified);
            let current_matches = find_text_in_paragraphs(&maps, &search_text);
            if current_matches.is_empty() {
                break;
            }
            // Always replace the last remaining match to avoid invalidating
            // earlier byte offsets (reverse order).
            let (pi, offset) = current_matches[current_matches.len() - 1];
            modified = replace_text_in_xml(
                &modified,
                &maps[pi],
                offset,
                search_text.len(),
                &replacement,
            );
        }

        *content = modified.into_bytes();
    }

    // Write back
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in &entries {
            writer
                .start_file(name, options)
                .map_err(|e| format!("Failed to write zip entry: {}", e))?;
            writer
                .write_all(content)
                .map_err(|e| format!("Failed to write content: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    }
    fs::write(&template_path, output.into_inner())
        .map_err(|e| format!("Failed to write docx: {}", e))?;

    // Return updated variable list
    extract_variables(template_path)
}

/// Replace a `{Variable Name}` placeholder back to plain text.
/// Returns the updated list of variables in the template.
#[tauri::command]
pub fn remove_template_variable(
    template_path: String,
    variable_name: String,
    replacement_text: String,
    occurrence_index: Option<usize>,
) -> Result<Vec<VariableInfo>, String> {
    info!(%template_path, %variable_name, "Removing template variable");

    let search_text = format!("{{{}}}", variable_name);
    let replace_all = occurrence_index.is_none();

    let file_bytes =
        fs::read(&template_path).map_err(|e| format!("Failed to read docx: {}", e))?;
    let cursor = Cursor::new(file_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open docx as zip: {}", e))?;

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

    for (name, content) in entries.iter_mut() {
        if name != "word/document.xml"
            && !name.starts_with("word/header")
            && !name.starts_with("word/footer")
        {
            continue;
        }

        let xml_str = String::from_utf8_lossy(content).to_string();
        let normalized = normalize_split_variables(&xml_str);
        let maps = build_paragraph_text_maps(&normalized);
        let matches = find_text_in_paragraphs(&maps, &search_text);

        if matches.is_empty() {
            continue;
        }

        let to_replace: Vec<(usize, usize)> = if replace_all {
            matches
        } else if let Some(idx) = occurrence_index {
            if idx >= matches.len() {
                return Err(format!(
                    "Occurrence index {} out of range (found {})",
                    idx,
                    matches.len()
                ));
            }
            vec![matches[idx]]
        } else {
            vec![matches[0]]
        };

        // Replace one match at a time, re-finding after each replacement
        // because replacing text can shift paragraph indices and byte offsets.
        let mut modified = normalized;
        let replace_count = to_replace.len();

        for _ in 0..replace_count {
            let maps = build_paragraph_text_maps(&modified);
            let current_matches = find_text_in_paragraphs(&maps, &search_text);
            if current_matches.is_empty() {
                break;
            }
            let (pi, offset) = current_matches[current_matches.len() - 1];
            modified = replace_text_in_xml(
                &modified,
                &maps[pi],
                offset,
                search_text.len(),
                &replacement_text,
            );
        }

        *content = modified.into_bytes();
    }

    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut output);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in &entries {
            writer
                .start_file(name, options)
                .map_err(|e| format!("Failed to write zip entry: {}", e))?;
            writer
                .write_all(content)
                .map_err(|e| format!("Failed to write content: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    }
    fs::write(&template_path, output.into_inner())
        .map_err(|e| format!("Failed to write docx: {}", e))?;

    extract_variables(template_path)
}

// ─── Template schema commands ───────────────────────────────────────────────

/// Derive the schema file path from a template's relative path.
/// E.g., "Trust Templates/Revocable Trust.docx" → "{templates_dir}/Trust Templates/Revocable Trust.lily"
fn schema_path_for_template(templates_dir: &str, template_rel_path: &str) -> PathBuf {
    let template_path = Path::new(templates_dir).join(template_rel_path);
    let stem = template_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = template_path.parent().unwrap_or(Path::new(templates_dir));
    parent.join(format!("{}.lily", stem))
}

/// Load the variable schema for a template. Returns a default (empty) schema
/// if no schema file exists.
#[tauri::command]
pub fn load_template_schema(
    templates_dir: String,
    template_rel_path: String,
) -> Result<VariableSchema, String> {
    let path = schema_path_for_template(&templates_dir, &template_rel_path);
    if !path.exists() {
        let template_filename = Path::new(&template_rel_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        return Ok(VariableSchema {
            template_filename,
            ..Default::default()
        });
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read schema: {}", e))?;
    let schema: VariableSchema =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse schema: {}", e))?;
    Ok(schema)
}

/// Save the variable schema for a template.
#[tauri::command]
pub fn save_template_schema(
    templates_dir: String,
    template_rel_path: String,
    schema: VariableSchema,
) -> Result<(), String> {
    let path = schema_path_for_template(&templates_dir, &template_rel_path);
    let content = serde_json::to_string_pretty(&schema)
        .map_err(|e| format!("Failed to serialize schema: {}", e))?;
    lily_file::atomic_write(&path, &content)
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

        // Check if this text has unbalanced braces — more `{` than `}` means
        // part of a variable extends into subsequent runs. Use depth tracking
        // to support nested variables (e.g., conditionals containing {Var}).
        let mut brace_depth: i32 = 0;
        for ch in text_content.chars() {
            if ch == '{' {
                brace_depth += 1;
            } else if ch == '}' {
                brace_depth -= 1;
            }
        }

        if brace_depth <= 0 || !text_content.contains('{') {
            // All braces balanced or net-negative — no split variable here
            search_from = abs_end;
            continue;
        }

        // We have unbalanced `{`. Collect text from subsequent <w:t> elements
        // until the brace depth returns to zero (outermost `}` is found).
        let mut merged_text = text_content.to_string();
        let mut scan_pos = abs_end;
        let mut last_consumed_end = abs_end;
        let mut found_close = false;

        while scan_pos < result.len() {
            let scan_remaining = &result[scan_pos..];
            let Some(next_t) = t_open_re.find(scan_remaining) else {
                break;
            };

            let next_abs_start = scan_pos + next_t.start();
            let next_abs_end = scan_pos + next_t.end();

            // Only merge within the same paragraph — stop at </w:p>
            let between = &result[last_consumed_end..next_abs_start];
            if between.contains("</w:p>") {
                break;
            }

            let next_text = &t_open_re.captures(scan_remaining).unwrap()[1];
            merged_text.push_str(next_text);
            last_consumed_end = next_abs_end;

            // Update brace depth with the new text
            for ch in next_text.chars() {
                if ch == '{' {
                    brace_depth += 1;
                } else if ch == '}' {
                    brace_depth -= 1;
                }
            }

            if brace_depth <= 0 {
                found_close = true;
                break;
            }

            scan_pos = next_abs_end;
        }

        if !found_close {
            // Couldn't find balancing `}`, skip
            search_from = abs_end;
            continue;
        }

        // Verify the merged text actually contains a valid {Variable} pattern
        // (uses depth-tracking to support nested variables in conditionals)
        let has_valid_var = {
            let mut found = false;
            let mut chars = merged_text.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '{' && scan_brace_content(&mut chars).is_some() {
                    found = true;
                    break;
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
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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
    rels: Option<String>,
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

    let rels = match archive.by_name("word/_rels/document.xml.rels") {
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
        rels,
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

/// Map from relationship ID (e.g., "rId5") to target URL.
type RelationshipMap = HashMap<String, String>;

/// Parse word/_rels/document.xml.rels to extract hyperlink targets.
fn parse_rels_xml(xml: &str) -> RelationshipMap {
    let mut rels = RelationshipMap::new();
    let reader = xml::reader::EventReader::from_str(xml);
    for event in reader {
        if let Ok(xml::reader::XmlEvent::StartElement {
            name, attributes, ..
        }) = event
        {
            if name.local_name == "Relationship" {
                let id = attributes
                    .iter()
                    .find(|a| a.name.local_name == "Id")
                    .map(|a| a.value.clone());
                let target = attributes
                    .iter()
                    .find(|a| a.name.local_name == "Target")
                    .map(|a| a.value.clone());
                let rel_type = attributes
                    .iter()
                    .find(|a| a.name.local_name == "Type")
                    .map(|a| a.value.clone())
                    .unwrap_or_default();
                // Only include hyperlink relationships
                if rel_type.contains("hyperlink") {
                    if let (Some(id), Some(target)) = (id, target) {
                        rels.insert(id, target);
                    }
                }
            }
        }
    }
    rels
}

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
    let mut conditional_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            if let Some(var_name) = scan_brace_content(&mut chars) {
                if var_name.is_empty() {
                    continue;
                }
                let trimmed = var_name.trim().to_string();
                if is_conditional_variable(&trimmed) {
                    if let Some((label, true_text, false_text)) =
                        parse_conditional_variable(&trimmed)
                    {
                        let key = label.to_lowercase();
                        conditional_keys.insert(key.clone());
                        if !groups.contains_key(&key) {
                            keys_in_order.push(key.clone());
                        }
                        let variants = groups.entry(key).or_default();
                        if !variants.contains(&trimmed) {
                            variants.push(trimmed);
                        }

                        // Also register nested replacement variables
                        for branch in [&true_text, &false_text] {
                            for nested in extract_nested_variables(branch) {
                                let nkey = nested.to_lowercase();
                                if !groups.contains_key(&nkey) {
                                    keys_in_order.push(nkey.clone());
                                }
                                let nvariants = groups.entry(nkey).or_default();
                                if !nvariants.contains(&nested) {
                                    nvariants.push(nested);
                                }
                            }
                        }
                    }
                } else if !trimmed.contains('{') {
                    // Simple replacement variable (no nested braces)
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

    keys_in_order
        .into_iter()
        .filter_map(|key| {
            groups.remove(&key).map(|variants| {
                let is_conditional = conditional_keys.contains(&key);
                let display_name = if is_conditional {
                    let raw = &variants[0];
                    parse_conditional_variable(raw)
                        .map(|(label, _, _)| label)
                        .unwrap_or_else(|| pick_display_name(&variants))
                } else {
                    pick_display_name(&variants)
                };
                VariableInfo {
                    display_name,
                    variants,
                    is_conditional,
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

/// Known contact property keys that can appear in `{Role.property}` syntax.
const CONTACT_PROPERTIES: &[&str] = &[
    "full_name",
    "first_name",
    "last_name",
    "relationship",
    "phone",
    "email",
    "address",
    "city",
    "state",
    "zip",
];

/// Try to parse `"Role.property"` contact-role dot notation.
/// Returns `Some((role, property))` if the text contains a dot followed by a
/// known contact property key (case-insensitive).
fn parse_contact_role_ref(text: &str) -> Option<(String, String)> {
    let dot_pos = text.rfind('.')?;
    let role = text[..dot_pos].trim();
    let property = text[dot_pos + 1..].trim();
    if role.is_empty() || property.is_empty() {
        return None;
    }
    let prop_lower = property.to_lowercase();
    if CONTACT_PROPERTIES.contains(&prop_lower.as_str()) {
        Some((role.to_string(), prop_lower))
    } else {
        None
    }
}

/// Convert a contact property key like `"full_name"` to title-case words: `"Full Name"`.
fn property_to_title(property: &str) -> String {
    property
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    format!("{}{}", upper, chars.collect::<String>())
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Convert `"Role.property"` dot notation to a flat canonical variable name.
/// e.g., `"Healthcare POA Agent.full_name"` → `"Healthcare POA Agent Full Name"`.
fn contact_role_to_flat_name(role: &str, property: &str) -> String {
    format!("{} {}", role, property_to_title(property))
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

/// Consume characters after an opening `{` from a peekable char iterator,
/// tracking brace depth to handle nested `{...}` blocks (e.g., replacement
/// variables inside conditional text branches). Returns the full content
/// between the outermost braces, or `None` if the closing `}` is never found.
///
/// After a successful call the iterator is positioned just past the closing `}`.
fn scan_brace_content(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<String> {
    let mut depth: u32 = 1;
    let mut content = String::new();
    for c in chars.by_ref() {
        if c == '{' {
            depth += 1;
            content.push(c);
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(content);
            }
            content.push(c);
        } else {
            content.push(c);
        }
    }
    None // Unbalanced — never found the outermost closing brace
}

/// Check whether a variable's raw content (between `{}`) is a conditional
/// variable. Conditional variables contain `??` as the ternary operator.
fn is_conditional_variable(raw_content: &str) -> bool {
    raw_content.contains("??")
}

/// Normalize smart / curly quotes to plain ASCII double quotes.
///
/// Word's "AutoFormat as you type" automatically converts straight quotes
/// (`"`) to left/right curly quotes (\u{201C} / \u{201D}).  This helper
/// ensures the conditional parser accepts both forms.
fn normalize_quotes(s: &str) -> String {
    s.replace(['\u{201C}', '\u{201D}'], "\"")
        .replace(['\u{2018}', '\u{2019}'], "'")
}

/// Find the first unescaped double-quote in `s`.
/// A quote preceded by a backslash (`\"`) is treated as escaped and skipped.
fn find_unescaped_quote(s: &str) -> Option<usize> {
    let mut chars = s.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if ch == '\\' {
            chars.next(); // skip escaped character
        } else if ch == '"' {
            return Some(i);
        }
    }
    None
}

/// Parse a conditional variable's raw content into (label, true_text, false_text).
///
/// Expected syntax:
///   `Client Is Single ?? "single text" :: "couple text"`
///   → `("Client Is Single", "single text", "couple text")`
///
/// Both branch texts must be wrapped in double quotes (straight or smart).
/// Content inside the quotes is preserved exactly (including whitespace).
/// The `::` separator between true and false branches is required.
fn parse_conditional_variable(raw_content: &str) -> Option<(String, String, String)> {
    // Normalize curly/smart quotes to straight quotes so the parser works
    // regardless of whether the user typed in Word (which auto-converts).
    let raw_content = normalize_quotes(raw_content);
    let (label, rest) = raw_content.split_once("??")?;
    let label = label.trim().to_string();
    if label.is_empty() {
        return None;
    }

    let rest = rest.trim();

    if !rest.starts_with('"') {
        return None;
    }

    // Find the closing quote for the true-text (skip escaped quotes)
    let after_open = &rest[1..];
    let close_idx = find_unescaped_quote(after_open)?;
    let true_text = after_open[..close_idx].replace("\\\"", "\"");

    // After the closing quote, look for ::
    let remainder = after_open[close_idx + 1..].trim();
    let false_text = if let Some(after_sep) = remainder.strip_prefix("::") {
        let after_sep = after_sep.trim();
        if after_sep.starts_with('"') {
            let inner = &after_sep[1..];
            if let Some(end) = find_unescaped_quote(inner) {
                inner[..end].replace("\\\"", "\"")
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    Some((label, true_text, false_text))
}

/// Extract all `{Variable Name}` references from a text string.
/// Returns a list of the raw inner content of each `{...}` found.
/// Only returns simple (non-nested) replacement variables — i.e., variables
/// whose content does NOT itself contain `{`.
fn extract_nested_variables(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut inner = String::new();
            let mut found_close = false;
            for ch in chars.by_ref() {
                if ch == '}' {
                    found_close = true;
                    break;
                }
                inner.push(ch);
            }
            if found_close && !inner.is_empty() && !inner.contains('{') {
                result.push(inner.trim().to_string());
            }
        }
    }
    result
}

/// Resolve `{Variable Name}` references in a text string using the provided
/// variable values map. Applies casing rules to each replacement based on the
/// original casing of the placeholder.
fn resolve_nested_variables(text: &str, variables: &HashMap<String, String>) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut inner = String::new();
            let mut found_close = false;
            for ch in chars.by_ref() {
                if ch == '}' {
                    found_close = true;
                    break;
                }
                inner.push(ch);
            }
            if found_close && !inner.is_empty() && !inner.contains('{') {
                let trimmed = inner.trim();
                // Map contact-role dot notation to flat key if applicable
                let key = if let Some((role, property)) = parse_contact_role_ref(trimmed) {
                    contact_role_to_flat_name(&role, &property).to_lowercase()
                } else {
                    trimmed.to_lowercase()
                };
                let resolved = variables
                    .iter()
                    .find(|(k, _)| k.to_lowercase() == key)
                    .map(|(_, v)| apply_casing(v, trimmed));
                if let Some(value) = resolved {
                    if !value.is_empty() {
                        result.push_str(&value);
                    } else {
                        // Empty value — keep the placeholder
                        result.push('{');
                        result.push_str(&inner);
                        result.push('}');
                    }
                } else {
                    // Unknown variable — keep the placeholder
                    result.push('{');
                    result.push_str(&inner);
                    result.push('}');
                }
            } else {
                result.push('{');
                result.push_str(&inner);
                if found_close {
                    result.push('}');
                }
            }
        } else {
            result.push(c);
        }
    }
    result
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
const BOOKMARK_PREFIX: &str = "lily:";

/// Find the maximum ID used by bookmarks and SDT content controls in an XML string.
/// Scans both `<w:bookmarkStart w:id="N".../>` and `<w:id w:val="N"/>` (inside `<w:sdtPr>`).
/// Returns 0 if no IDs exist.
fn find_max_id(xml: &str) -> u64 {
    let bookmark_re = Regex::new(r#"<w:bookmarkStart\s+w:id="(\d+)""#).expect("invalid regex");
    let sdt_id_re = Regex::new(r#"<w:id\s+w:val="(\d+)""#).expect("invalid regex");
    let max_bookmark = bookmark_re
        .captures_iter(xml)
        .filter_map(|c| c[1].parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let max_sdt = sdt_id_re
        .captures_iter(xml)
        .filter_map(|c| c[1].parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    max_bookmark.max(max_sdt)
}

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
///   <w:sdtPr>
///     <w:id w:val="N"/>
///     <w:tag w:val="lily:Display Name"/>
///     <w:alias w:val="Display Name"/>
///   </w:sdtPr>
///   <w:sdtContent><w:r>...<w:t>value</w:t></w:r></w:sdtContent>
/// </w:sdt>
/// ```
///
/// The `replacements` map goes from original-cased variant to
/// (display_name, cased_value).
fn replace_placeholders_with_sdt(
    xml: &str,
    replacements: &HashMap<String, (String, String)>,
    next_id: &mut u64,
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

                        // The SDT-wrapped replacement.
                        // The tag uses the display_name (label) for the SDT
                        // identity. Definitions are stored in the .lily file.
                        let escaped_val = escape_xml_text(value);
                        let escaped_display = escape_xml_text(display_name);
                        if value.is_empty() {
                            let bid = *next_id;
                            *next_id += 1;
                            output_parts.push(format!(
                                "<w:bookmarkStart w:id=\"{}\" w:name=\"{}{}\"/><w:bookmarkEnd w:id=\"{}\"/>",
                                bid, BOOKMARK_PREFIX, escaped_display, bid
                            ));
                        } else {
                            let sdt_id = *next_id;
                            *next_id += 1;
                            output_parts.push(format!(
                                "<w:sdt><w:sdtPr><w:id w:val=\"{}\"/><w:tag w:val=\"{}{}\"/><w:alias w:val=\"{}\"/></w:sdtPr><w:sdtContent><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:sdtContent></w:sdt>",
                                sdt_id, SDT_TAG_PREFIX, escaped_display, escaped_display, rpr, escaped_val
                            ));
                        }

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

/// Update existing Lily variable markers in the XML.
///
/// Handles two kinds of markers:
/// 1. **SDT content controls** (`<w:sdt>` with a `lily:` tag) — updates the
///    text inside, or converts to a zero-width bookmark when the value is empty.
/// 2. **Bookmarks** (`<w:bookmarkStart w:name="lily:..."/>`) — converts back
///    to an SDT when the value becomes non-empty.
///
/// For conditional variables, the definitions are looked up from the
/// `conditional_definitions` map (stored in the `.lily` file) by matching
/// each occurrence in document order to the corresponding definition.
fn update_sdt_and_bookmark_values(
    xml: &str,
    values: &HashMap<String, String>,
    all_variables: &HashMap<String, String>,
    conditional_definitions: &HashMap<String, Vec<String>>,
    next_id: &mut u64,
) -> String {
    if values.is_empty() {
        return xml.to_string();
    }

    // Track occurrence index per label so the Nth marker for a label
    // maps to the Nth definition in conditional_definitions.
    let mut occurrence_counts: HashMap<String, usize> = HashMap::new();

    // Helper: resolve a label's value for its Nth occurrence.
    let mut resolve_label = |label: &str| -> Option<String> {
        let value = values.get(label)?;

        if let Some(defs) = conditional_definitions.get(label) {
            let idx = occurrence_counts.entry(label.to_string()).or_insert(0);
            let def = defs.get(*idx).or_else(|| defs.first())?;
            *idx += 1;

            let (_, true_text, false_text) = parse_conditional_variable(def)?;
            let is_true = value == "true";
            let branch = if is_true { true_text } else { false_text };
            Some(resolve_nested_variables(&branch, all_variables))
        } else {
            Some(value.clone())
        }
    };

    // Single-pass replacement: match both SDTs and bookmarks in document
    // order using a combined regex so occurrence counters stay correct.
    let combined_re = Regex::new(
        r#"(?:<w:sdt>(.*?)</w:sdt>|<w:bookmarkStart\s+w:id="\d+"\s+w:name="lily:([^"]*)"\s*/><w:bookmarkEnd\s+w:id="\d+"\s*/>)"#
    ).expect("invalid regex");
    let tag_re = Regex::new(r#"<w:tag\s+w:val="lily:([^"]*)"\s*/>"#).expect("invalid regex");
    let t_re = Regex::new(r#"<w:t(?: [^>]*)?>([^<]*)</w:t>"#).expect("invalid regex");
    let rpr_re = Regex::new(r#"<w:rPr>(.*?)</w:rPr>"#).expect("invalid regex");

    let mut result = String::new();
    let mut last_end = 0;

    for caps in combined_re.captures_iter(xml) {
        let m = caps.get(0).unwrap();
        result.push_str(&xml[last_end..m.start()]);
        last_end = m.end();

        if let Some(sdt_inner) = caps.get(1) {
            // ── SDT match ───────────────────────────────────────────
            let inner = sdt_inner.as_str();
            let Some(tag_caps) = tag_re.captures(inner) else {
                result.push_str(m.as_str());
                continue;
            };
            let label = &tag_caps[1];

            if !values.contains_key(label) {
                result.push_str(m.as_str());
                continue;
            }

            let Some(resolved) = resolve_label(label) else {
                result.push_str(m.as_str());
                continue;
            };

            let escaped_label = escape_xml_text(label);

            if resolved.is_empty() {
                let bid = *next_id;
                *next_id += 1;
                result.push_str(&format!(
                    "<w:bookmarkStart w:id=\"{}\" w:name=\"{}{}\"/><w:bookmarkEnd w:id=\"{}\"/>",
                    bid, BOOKMARK_PREFIX, escaped_label, bid
                ));
            } else {
                let new_value = escape_xml_text(&resolved);

                if !t_re.is_match(inner) {
                    let sdt_id = *next_id;
                    *next_id += 1;
                    result.push_str(&format!(
                        "<w:sdt><w:sdtPr><w:id w:val=\"{}\"/><w:tag w:val=\"{}{}\"/><w:alias w:val=\"{}\"/></w:sdtPr><w:sdtContent><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:sdtContent></w:sdt>",
                        sdt_id, SDT_TAG_PREFIX, escaped_label, escaped_label, new_value
                    ));
                } else {
                    let new_inner = t_re
                        .replace(inner, |t_caps: &regex::Captures| {
                            let full = t_caps[0].to_string();
                            let tag_end = full.find('>').unwrap() + 1;
                            format!("{}{}</w:t>", &full[..tag_end], new_value)
                        })
                        .to_string();
                    result.push_str(&format!("<w:sdt>{}</w:sdt>", new_inner));
                }
            }
        } else if let Some(bm_label) = caps.get(2) {
            // ── Bookmark match ──────────────────────────────────────
            let label = bm_label.as_str();

            if !values.contains_key(label) {
                result.push_str(m.as_str());
                continue;
            }

            let Some(resolved) = resolve_label(label) else {
                result.push_str(m.as_str());
                continue;
            };

            let escaped_label = escape_xml_text(label);

            if resolved.is_empty() {
                let bid = *next_id;
                *next_id += 1;
                result.push_str(&format!(
                    "<w:bookmarkStart w:id=\"{}\" w:name=\"{}{}\"/><w:bookmarkEnd w:id=\"{}\"/>",
                    bid, BOOKMARK_PREFIX, escaped_label, bid
                ));
            } else {
                // Extract run properties from the preceding XML context
                // so the new SDT inherits the same font/size/style.
                let preceding = &xml[..m.start()];
                let rpr = rpr_re
                    .find_iter(preceding)
                    .last()
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                let escaped_value = escape_xml_text(&resolved);
                let sdt_id = *next_id;
                *next_id += 1;
                result.push_str(&format!(
                    "<w:sdt><w:sdtPr><w:id w:val=\"{}\"/><w:tag w:val=\"{}{}\"/><w:alias w:val=\"{}\"/></w:sdtPr><w:sdtContent><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:sdtContent></w:sdt>",
                    sdt_id, SDT_TAG_PREFIX, escaped_label, escaped_label, rpr, escaped_value
                ));
            }
        }
    }

    result.push_str(&xml[last_end..]);
    result
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
fn xml_to_preview_html(xml: &str, numbering_map: &NumberingMap, style_map: &StyleMap, rels_map: &RelationshipMap) -> String {
    let mut html = String::from("<div class=\"document-preview\">");
    let mut current_para = String::new();

    // Hyperlink state
    let mut in_hyperlink = false;
    let mut hyperlink_url: Option<String> = None;

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
    let mut font_family: Option<String> = None;

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
    let mut pending_font_family: Option<String> = None;

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
                    // ─── Hyperlink ─────────────────────────────────────
                    "hyperlink" => {
                        in_hyperlink = true;
                        hyperlink_url = attributes
                            .iter()
                            .find(|a| a.name.local_name == "id")
                            .and_then(|a| rels_map.get(&a.value).cloned());
                        if let Some(ref url) = hyperlink_url {
                            current_para.push_str(&format!(
                                "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"link link-primary\">",
                                escape_html(url)
                            ));
                        }
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
                    // ─── Lily bookmarks (empty variable placeholders) ─
                    "bookmarkStart" => {
                        for attr in &attributes {
                            if attr.name.local_name == "name"
                                && attr.value.starts_with(BOOKMARK_PREFIX)
                            {
                                let var_name = &attr.value[BOOKMARK_PREFIX.len()..];
                                let canonical = var_name.to_lowercase();
                                current_para.push_str(&format!(
                                    "<span class=\"variable-bookmark\" data-variable=\"{}\" data-original-case=\"{}\"></span>",
                                    escape_html(&canonical), escape_html(var_name)
                                ));
                            }
                        }
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
                    "rFonts" if in_rpr => {
                        // Prefer ascii font, fall back to hAnsi, then cs
                        pending_font_family = attributes
                            .iter()
                            .find(|a| a.name.local_name == "ascii")
                            .or_else(|| attributes.iter().find(|a| a.name.local_name == "hAnsi"))
                            .or_else(|| attributes.iter().find(|a| a.name.local_name == "cs"))
                            .map(|a| a.value.clone());
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
                // ─── Hyperlink end ──────────────────────────────
                "hyperlink" => {
                    if in_hyperlink && hyperlink_url.is_some() {
                        current_para.push_str("</a>");
                    }
                    in_hyperlink = false;
                    hyperlink_url = None;
                }
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
                    font_family = pending_font_family.clone();
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

                    // If we're inside a Lily SDT content, wrap in a variable span.
                    // The span only gets data-variable and data-original-case;
                    // conditional logic is handled by the frontend using
                    // definitions from the .lily file.
                    let highlighted = if in_sdt_content {
                        if let Some(ref var_name) = sdt_var_name {
                            let canonical = var_name.to_lowercase();
                            format!(
                                "<span class=\"variable-highlight filled\" data-variable=\"{}\" data-original-case=\"{}\">{}</span>",
                                escape_html(&canonical), escape_html(var_name), escaped
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

                    // Build inline style for font size, color, highlight, font family
                    let mut run_styles = Vec::new();
                    if let Some(ref ff) = font_family {
                        run_styles.push(format!("font-family:\"{}\"", ff));
                    }
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
///
/// Conditional variables (`{Label ?? true :: false}`) get extra
/// `data-conditional`, `data-true-text`, and `data-false-text` attributes
/// so the frontend can toggle between the two text branches.
fn highlight_variables(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            if let Some(var_content) = scan_brace_content(&mut chars) {
                if var_content.is_empty() {
                    result.push_str("{}");
                    continue;
                }
                let trimmed = var_content.trim();
                if is_conditional_variable(trimmed) {
                    if let Some((label, true_text, false_text)) =
                        parse_conditional_variable(trimmed)
                    {
                        let canonical = label.to_lowercase();
                        result.push_str(&format!(
                            "<span class=\"variable-highlight\" data-variable=\"{}\" data-original-case=\"{}\" data-conditional=\"true\" data-true-text=\"{}\" data-false-text=\"{}\">{{{}}}</span>",
                            escape_html(&canonical),
                            escape_html(&label),
                            escape_html(&true_text),
                            escape_html(&false_text),
                            escape_html(&var_content)
                        ));
                    } else {
                        // Malformed conditional — treat as plain text
                        result.push('{');
                        result.push_str(&escape_html(&var_content));
                        result.push('}');
                    }
                } else if !trimmed.contains('{') {
                    // Simple replacement variable (may use contact-role dot notation)
                    let canonical = if let Some((role, property)) =
                        parse_contact_role_ref(trimmed)
                    {
                        contact_role_to_flat_name(&role, &property).to_lowercase()
                    } else {
                        trimmed.to_lowercase()
                    };
                    result.push_str(&format!(
                        "<span class=\"variable-highlight\" data-variable=\"{}\" data-original-case=\"{}\">{{{}}}</span>",
                        canonical, var_content, var_content
                    ));
                } else {
                    // Contains nested braces but isn't a conditional — emit as-is
                    result.push('{');
                    result.push_str(&var_content);
                    result.push('}');
                }
            } else {
                // Unbalanced brace — emit the `{` literally
                result.push('{');
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
        let mut next_bid = 1u64;
        let result = replace_placeholders_with_sdt(xml, &replacements, &mut next_bid);
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
        // SDT must include a unique ID for Word compatibility
        assert!(
            result.contains("<w:id w:val=\"1\"/>"),
            "Expected SDT ID, got: {}",
            result
        );
        // The next_id counter should have been incremented
        assert_eq!(next_bid, 2);
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
        let mut next_bid = 1u64;
        let all_vars = HashMap::new();
        let cond_defs = HashMap::new();
        let result =
            update_sdt_and_bookmark_values(xml, &values, &all_vars, &cond_defs, &mut next_bid);
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
    fn test_bookmark_to_sdt_includes_id() {
        // When a bookmark gets a value, it should become an SDT with a <w:id>
        let xml = r#"<w:r><w:rPr><w:b/></w:rPr><w:t>before </w:t></w:r><w:bookmarkStart w:id="5" w:name="lily:Client Name"/><w:bookmarkEnd w:id="5"/><w:r><w:t> after</w:t></w:r>"#;
        let mut values = HashMap::new();
        values.insert("Client Name".to_string(), "Jane Doe".to_string());
        let mut next_id = 10u64;
        let all_vars = HashMap::new();
        let cond_defs = HashMap::new();
        let result =
            update_sdt_and_bookmark_values(xml, &values, &all_vars, &cond_defs, &mut next_id);
        assert!(
            result.contains("<w:id w:val=\"10\"/>"),
            "Expected SDT ID in bookmark-to-SDT conversion, got: {}",
            result
        );
        assert!(
            result.contains("Jane Doe"),
            "Expected value, got: {}",
            result
        );
        assert_eq!(next_id, 11, "next_id should have been incremented");
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
        let empty_rels = RelationshipMap::new();
        // Use a namespace-declared root so xml-rs can parse w: prefixed elements
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:sdt><w:sdtPr><w:tag w:val="lily:Client Name"/></w:sdtPr><w:sdtContent><w:r><w:t>Jane Doe</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Centered text</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>Indented text</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Before</w:t></w:r><w:r><w:tab/><w:t>After</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
        assert!(html.contains("<br>"), "Expected line break, got: {}", html);
    }

    #[test]
    fn test_preview_table() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>struck</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>th</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
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
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="36"/></w:rPr><w:t>big</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
        assert!(
            html.contains("font-size:18.0pt"),
            "Expected 18pt font size (36 half-pts), got: {}",
            html
        );
    }

    // ─── Conditional variable tests ─────────────────────────────────────

    #[test]
    fn test_is_conditional_variable() {
        assert!(is_conditional_variable(
            r#"Client Is Single ?? "single text" :: "couple text""#
        ));
        assert!(is_conditional_variable(r#"Label ?? "true" :: "false""#));
        assert!(is_conditional_variable(
            r#"Label ?? "only true text" :: """#
        ));
        assert!(!is_conditional_variable("Client Name"));
        assert!(!is_conditional_variable("Date"));
        // Single ? should NOT be treated as conditional
        assert!(!is_conditional_variable("What is this?"));
    }

    #[test]
    fn test_parse_conditional_variable() {
        let result =
            parse_conditional_variable(r#"Client Is Single ?? "single text" :: "couple text""#);
        assert_eq!(
            result,
            Some((
                "Client Is Single".to_string(),
                "single text".to_string(),
                "couple text".to_string()
            ))
        );
    }

    #[test]
    fn test_parse_conditional_variable_quoted_empty_false() {
        let result = parse_conditional_variable(r#"Client Is Single ?? "single text" :: """#);
        assert_eq!(
            result,
            Some((
                "Client Is Single".to_string(),
                "single text".to_string(),
                String::new()
            ))
        );
    }

    #[test]
    fn test_parse_conditional_variable_quoted_preserves_spaces() {
        // Trailing space inside quotes should be preserved
        let result =
            parse_conditional_variable(r#"Label ?? "text with trailing space " :: "other text""#);
        assert_eq!(
            result,
            Some((
                "Label".to_string(),
                "text with trailing space ".to_string(),
                "other text".to_string()
            ))
        );
    }

    #[test]
    fn test_parse_conditional_variable_with_special_content() {
        // Colons and :: inside quotes should be preserved as content
        let result = parse_conditional_variable(
            r#"Is Trust ?? "Trust dated: Jan 1, 2020" :: "No trust :: established""#,
        );
        assert_eq!(
            result,
            Some((
                "Is Trust".to_string(),
                "Trust dated: Jan 1, 2020".to_string(),
                "No trust :: established".to_string()
            ))
        );
    }

    #[test]
    fn test_parse_conditional_variable_rejects_unquoted() {
        // Unquoted syntax should no longer parse
        let result = parse_conditional_variable("Label ?? true text :: false text");
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_conditional_variable_smart_quotes() {
        // Word's "AutoFormat as you type" converts straight quotes to curly
        // quotes (\u{201C}/\u{201D}).  The parser must accept them.
        let result = parse_conditional_variable(
            "Label ?? \u{201C}true text\u{201D} :: \u{201C}false text\u{201D}",
        );
        assert_eq!(
            result,
            Some((
                "Label".to_string(),
                "true text".to_string(),
                "false text".to_string()
            ))
        );
    }

    #[test]
    fn test_parse_conditional_variable_smart_quotes_with_nested() {
        let result = parse_conditional_variable(
            "Has HPOA #2 ?? \u{201C}If {HPOA #1 Full Name} is unable\u{201D} :: \u{201C}\u{201D}",
        );
        assert_eq!(
            result,
            Some((
                "Has HPOA #2".to_string(),
                "If {HPOA #1 Full Name} is unable".to_string(),
                String::new()
            ))
        );
    }

    #[test]
    fn test_find_variables_conditional() {
        let text =
            r#"Hello {Client Is Single ?? "single text" :: "couple text"} and {Client Name}"#;
        let vars = find_variables(text);
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].display_name, "Client Is Single");
        assert!(vars[0].is_conditional);
        assert_eq!(vars[1].display_name, "Client Name");
        assert!(!vars[1].is_conditional);
    }

    #[test]
    fn test_highlight_variables_conditional() {
        let result = highlight_variables(r#"{Client Is Single ?? "single text" :: "couple text"}"#);
        assert!(
            result.contains("data-conditional=\"true\""),
            "Expected conditional attribute, got: {}",
            result
        );
        assert!(
            result.contains("data-variable=\"client is single\""),
            "Expected canonical key from label, got: {}",
            result
        );
        assert!(
            result.contains("data-true-text=\"single text\""),
            "Expected true text, got: {}",
            result
        );
        assert!(
            result.contains("data-false-text=\"couple text\""),
            "Expected false text, got: {}",
            result
        );
    }

    #[test]
    fn test_highlight_variables_conditional_empty_branch() {
        let result = highlight_variables(r#"{Client Is Single ?? "" :: "couple text"}"#);
        assert!(result.contains("data-conditional=\"true\""));
        assert!(result.contains("data-true-text=\"\""));
        assert!(result.contains("data-false-text=\"couple text\""));
    }

    // ─── Nested variable tests ──────────────────────────────────────────

    #[test]
    fn test_find_variables_nested_in_conditional() {
        let text = r#"Hello {Client Is Couple ?? "I am married to {Client Spouse Name}" :: "I am not married"}"#;
        let vars = find_variables(text);
        assert_eq!(vars.len(), 2, "Expected 2 variables, got: {:?}", vars);
        assert_eq!(vars[0].display_name, "Client Is Couple");
        assert!(vars[0].is_conditional);
        assert_eq!(vars[1].display_name, "Client Spouse Name");
        assert!(!vars[1].is_conditional);
    }

    #[test]
    fn test_find_all_variables_nested_in_conditional() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{Client Is Couple ?? "married to {Spouse Name}" :: "single"}</w:t></w:r></w:p></w:body></w:document>"#;
        let normalized = normalize_split_variables(xml);
        let vars = find_all_variables(&normalized);
        assert_eq!(vars.len(), 2, "Expected 2 variables, got: {:?}", vars);
        assert_eq!(vars[0].display_name, "Client Is Couple");
        assert!(vars[0].is_conditional);
        assert_eq!(vars[1].display_name, "Spouse Name");
        assert!(!vars[1].is_conditional);
    }

    #[test]
    fn test_highlight_variables_nested_conditional() {
        let result = highlight_variables(
            r#"{Client Is Couple ?? "I am married to {Client Spouse Name}" :: "I am not married"}"#,
        );
        // Should produce a single conditional span for the outer variable
        assert!(
            result.contains("data-conditional=\"true\""),
            "Expected conditional attribute, got: {}",
            result
        );
        assert!(
            result.contains("data-variable=\"client is couple\""),
            "Expected canonical key from label, got: {}",
            result
        );
        // The true text should contain the nested {Client Spouse Name} reference
        assert!(
            result.contains("data-true-text=\"I am married to {Client Spouse Name}\""),
            "Expected true text with nested var, got: {}",
            result
        );
        assert!(
            result.contains("data-false-text=\"I am not married\""),
            "Expected false text, got: {}",
            result
        );
    }

    #[test]
    fn test_resolve_nested_variables() {
        let mut vars = HashMap::new();
        vars.insert("Client Spouse Name".to_string(), "Jane Doe".to_string());
        vars.insert("City".to_string(), "Denver".to_string());

        let result =
            resolve_nested_variables("I am married to {Client Spouse Name} in {City}", &vars);
        assert_eq!(result, "I am married to Jane Doe in Denver");
    }

    #[test]
    fn test_resolve_nested_variables_casing() {
        let mut vars = HashMap::new();
        vars.insert("Client Spouse Name".to_string(), "Jane Doe".to_string());

        // ALL CAPS variant should uppercase the value
        let result = resolve_nested_variables("married to {CLIENT SPOUSE NAME}", &vars);
        assert_eq!(result, "married to JANE DOE");
    }

    #[test]
    fn test_resolve_nested_variables_missing() {
        let vars = HashMap::new();
        let result = resolve_nested_variables("married to {Unknown Var}", &vars);
        assert_eq!(result, "married to {Unknown Var}");
    }

    #[test]
    fn test_scan_brace_content_nested() {
        let text = "outer ?? text {inner} :: end}rest";
        let mut chars = text.chars().peekable();
        let content = scan_brace_content(&mut chars);
        // Note: scan_brace_content is called AFTER the opening {, so we simulate
        // by including the content after the first {
        assert_eq!(content, Some("outer ?? text {inner} :: end".to_string()));
    }

    #[test]
    fn test_scan_brace_content_simple() {
        let text = "Client Name}more";
        let mut chars = text.chars().peekable();
        let content = scan_brace_content(&mut chars);
        assert_eq!(content, Some("Client Name".to_string()));
    }

    #[test]
    fn test_scan_brace_content_unbalanced() {
        let text = "no closing brace";
        let mut chars = text.chars().peekable();
        let content = scan_brace_content(&mut chars);
        assert_eq!(content, None);
    }

    #[test]
    fn test_hpoa_snippet_full() {
        // Exact snippet from user's HPOA template
        let text = r#"If I am unable to make my own health care decisions, I designate {HPOA #1 Full Name}, who can be reached at {HPOA #1 Phone}, to serve as my Healthcare Representative. {Has HPOA #2 ?? "If {HPOA #1 Full Name} is unable or unwilling to serve, I appoint {HPOA #2 Full Name}, who can be reached at {HPOA #2 Phone}, to serve as my Healthcare Representative. " :: ""}{Has HPOA #3 ?? "If {HPOA #2 Full Name} is unable or unwilling to serve, I appoint {HPOA #3 Full Name}, who can be reached at {HPOA #3 Phone}, to serve as my Healthcare Representative." :: ""}"#;
        let vars = find_variables(text);
        let var_names: Vec<&str> = vars.iter().map(|v| v.display_name.as_str()).collect();

        // Should find: HPOA #1 Full Name, HPOA #1 Phone, Has HPOA #2,
        // HPOA #2 Full Name, HPOA #2 Phone, Has HPOA #3, HPOA #3 Full Name, HPOA #3 Phone
        assert!(
            var_names.contains(&"HPOA #1 Full Name"),
            "Missing HPOA #1 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #1 Phone"),
            "Missing HPOA #1 Phone"
        );
        assert!(var_names.contains(&"Has HPOA #2"), "Missing Has HPOA #2");
        assert!(
            var_names.contains(&"HPOA #2 Full Name"),
            "Missing HPOA #2 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #2 Phone"),
            "Missing HPOA #2 Phone"
        );
        assert!(var_names.contains(&"Has HPOA #3"), "Missing Has HPOA #3");
        assert!(
            var_names.contains(&"HPOA #3 Full Name"),
            "Missing HPOA #3 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #3 Phone"),
            "Missing HPOA #3 Phone"
        );
    }

    #[test]
    fn test_hpoa_snippet_resolve() {
        let mut vars = HashMap::new();
        vars.insert("HPOA #1 Full Name".to_string(), "John Smith".to_string());
        vars.insert("HPOA #2 Full Name".to_string(), "Jane Doe".to_string());
        vars.insert("HPOA #2 Phone".to_string(), "555-1234".to_string());
        vars.insert("HPOA #3 Full Name".to_string(), "Bob Jones".to_string());
        vars.insert("HPOA #3 Phone".to_string(), "555-5678".to_string());

        let true_text_2 = "If {HPOA #1 Full Name} is unable or unwilling to serve, I appoint {HPOA #2 Full Name}, who can be reached at {HPOA #2 Phone}, to serve as my Healthcare Representative. ";
        let resolved_2 = resolve_nested_variables(true_text_2, &vars);
        assert_eq!(resolved_2, "If John Smith is unable or unwilling to serve, I appoint Jane Doe, who can be reached at 555-1234, to serve as my Healthcare Representative. ");

        let true_text_3 = "If {HPOA #2 Full Name} is unable or unwilling to serve, I appoint {HPOA #3 Full Name}, who can be reached at {HPOA #3 Phone}, to serve as my Healthcare Representative.";
        let resolved_3 = resolve_nested_variables(true_text_3, &vars);
        assert_eq!(resolved_3, "If Jane Doe is unable or unwilling to serve, I appoint Bob Jones, who can be reached at 555-5678, to serve as my Healthcare Representative.");
    }

    #[test]
    fn test_hpoa_highlight() {
        let text = r#"{Has HPOA #2 ?? "If {HPOA #1 Full Name} is unable, I appoint {HPOA #2 Full Name}, reachable at {HPOA #2 Phone}. " :: ""}"#;
        let result = highlight_variables(text);
        assert!(
            result.contains("data-conditional=\"true\""),
            "Expected conditional, got: {}",
            result
        );
        assert!(
            result.contains("data-variable=\"has hpoa #2\""),
            "Expected canonical key, got: {}",
            result
        );
        assert!(
            result.contains("{HPOA #1 Full Name}"),
            "Expected nested var in true-text, got: {}",
            result
        );
        assert!(
            result.contains("{HPOA #2 Full Name}"),
            "Expected nested var in true-text, got: {}",
            result
        );
        assert!(
            result.contains("{HPOA #2 Phone}"),
            "Expected nested var in true-text, got: {}",
            result
        );
    }

    #[test]
    fn test_hpoa_actual_docx() {
        // Test against the actual HPOA Template.docx file which contains
        // smart/curly quotes (Word's "AutoFormat as you type" converts
        // straight " to \u{201C}/\u{201D}).
        let path = std::path::Path::new("../resources/templates/test/HPOA Template.docx");
        if !path.exists() {
            eprintln!("HPOA Template.docx not found at {:?}, skipping", path);
            return;
        }
        let docx_path = path.to_string_lossy().to_string();
        let vars = extract_variables(docx_path).expect("Failed to extract variables");
        let var_names: Vec<&str> = vars.iter().map(|v| v.display_name.as_str()).collect();

        assert!(
            var_names.contains(&"HPOA #1 Full Name"),
            "Missing HPOA #1 Full Name, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"HPOA #1 Phone"),
            "Missing HPOA #1 Phone, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"Has HPOA #2"),
            "Missing Has HPOA #2, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"HPOA #2 Full Name"),
            "Missing HPOA #2 Full Name, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"HPOA #2 Phone"),
            "Missing HPOA #2 Phone, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"Has HPOA #3"),
            "Missing Has HPOA #3, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"HPOA #3 Full Name"),
            "Missing HPOA #3 Full Name, found: {:?}",
            var_names
        );
        assert!(
            var_names.contains(&"HPOA #3 Phone"),
            "Missing HPOA #3 Phone, found: {:?}",
            var_names
        );
    }

    #[test]
    fn test_hpoa_real_xml_split_runs() {
        // Real Word XML from the HPOA template — Word splits the conditional
        // variable text across multiple runs due to bold formatting on nested
        // variable names.
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">If I am unable to make my own health care decisions, I designate </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">{HPOA #1 Full Name}</w:t></w:r><w:r><w:t xml:space="preserve">, who can be reached at {HPOA #1 Phone}</w:t></w:r><w:r><w:t xml:space="preserve">, to serve as my Healthcare Representative. {Has HPOA #2 ?? "If </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">{HPOA #1 Full Name}</w:t></w:r><w:r><w:t xml:space="preserve"> is unable or unwilling to serve, I appoint </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">{HPOA #2 Full Name}</w:t></w:r><w:r><w:t xml:space="preserve">, who can be reached at </w:t></w:r><w:r><w:t xml:space="preserve">{HPOA #2 Phone}</w:t></w:r><w:r><w:t xml:space="preserve">, to serve as my Healthcare Representative. " :: ""}{Has HPOA #3 ?? "If </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">{HPOA #2 Full Name}</w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t xml:space="preserve">i</w:t></w:r><w:r><w:t xml:space="preserve">s unable or unwilling to serve, I appoint </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">{HPOA #3 Full Name}</w:t></w:r><w:r><w:t xml:space="preserve">, who can be reached at </w:t></w:r><w:r><w:t xml:space="preserve">{HPOA #3 Phone}</w:t></w:r><w:r><w:t xml:space="preserve">, to serve as my Healthcare Representative." :: ""}</w:t></w:r></w:p></w:body></w:document>"#;

        let normalized = normalize_split_variables(xml);
        let vars = find_all_variables(&normalized);
        let var_names: Vec<&str> = vars.iter().map(|v| v.display_name.as_str()).collect();

        assert!(
            var_names.contains(&"HPOA #1 Full Name"),
            "Missing HPOA #1 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #1 Phone"),
            "Missing HPOA #1 Phone"
        );
        assert!(var_names.contains(&"Has HPOA #2"), "Missing Has HPOA #2");
        assert!(
            var_names.contains(&"HPOA #2 Full Name"),
            "Missing HPOA #2 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #2 Phone"),
            "Missing HPOA #2 Phone"
        );
        assert!(var_names.contains(&"Has HPOA #3"), "Missing Has HPOA #3");
        assert!(
            var_names.contains(&"HPOA #3 Full Name"),
            "Missing HPOA #3 Full Name"
        );
        assert!(
            var_names.contains(&"HPOA #3 Phone"),
            "Missing HPOA #3 Phone"
        );
    }

    #[test]
    fn test_preview_heading_style() {
        let empty_num = NumberingMap::new();
        let empty_styles = StyleMap::new();
        let empty_rels = RelationshipMap::new();
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p></w:body></w:document>"#;
        let html = xml_to_preview_html(xml, &empty_num, &empty_styles, &empty_rels);
        assert!(html.contains("<h1"), "Expected h1 element, got: {}", html);
    }

    // ─── Contact-role dot notation tests ─────────────────────────────────

    #[test]
    fn test_parse_contact_role_ref() {
        let (role, prop) = parse_contact_role_ref("Healthcare POA Agent.full_name").unwrap();
        assert_eq!(role, "Healthcare POA Agent");
        assert_eq!(prop, "full_name");
    }

    #[test]
    fn test_parse_contact_role_ref_unknown_property() {
        assert!(parse_contact_role_ref("Agent.unknown_prop").is_none());
    }

    #[test]
    fn test_parse_contact_role_ref_no_dot() {
        assert!(parse_contact_role_ref("Client Full Name").is_none());
    }

    #[test]
    fn test_property_to_title() {
        assert_eq!(property_to_title("full_name"), "Full Name");
        assert_eq!(property_to_title("phone"), "Phone");
        assert_eq!(property_to_title("first_name"), "First Name");
    }

    #[test]
    fn test_contact_role_to_flat_name() {
        assert_eq!(
            contact_role_to_flat_name("Healthcare POA Agent", "full_name"),
            "Healthcare POA Agent Full Name"
        );
        assert_eq!(
            contact_role_to_flat_name("Financial POA Agent", "phone"),
            "Financial POA Agent Phone"
        );
    }

    #[test]
    fn test_find_variables_contact_role_dot_notation() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{Healthcare POA Agent.full_name}</w:t></w:r></w:p></w:body></w:document>"#;
        let vars = find_all_variables(xml);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].display_name, "Healthcare POA Agent Full Name");
        assert!(vars[0].variants.contains(&"Healthcare POA Agent.full_name".to_string()));
    }

    #[test]
    fn test_highlight_contact_role_dot_notation() {
        let text = "{Healthcare POA Agent.full_name}";
        let html = highlight_variables(text);
        assert!(
            html.contains("data-variable=\"healthcare poa agent full name\""),
            "Expected flat canonical key in data-variable, got: {}",
            html
        );
    }

    #[test]
    fn test_resolve_nested_contact_role_dot_notation() {
        let mut vars = HashMap::new();
        vars.insert(
            "Healthcare POA Alternate Agent Full Name".to_string(),
            "Jane Doe".to_string(),
        );
        let text = "{Healthcare POA Alternate Agent.full_name}";
        let result = resolve_nested_variables(text, &vars);
        assert_eq!(result, "Jane Doe");
    }

    #[test]
    fn test_find_nested_contact_role_in_conditional() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{Has Alt ?? "{Alt Agent.full_name}" :: ""}</w:t></w:r></w:p></w:body></w:document>"#;
        let vars = find_all_variables(xml);
        // Should find the conditional AND the nested contact-role variable
        let names: Vec<&str> = vars.iter().map(|v| v.display_name.as_str()).collect();
        assert!(names.contains(&"Has Alt"), "Expected 'Has Alt', got: {:?}", names);
        assert!(
            names.contains(&"Alt Agent Full Name"),
            "Expected 'Alt Agent Full Name', got: {:?}",
            names
        );
    }
}
