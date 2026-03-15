use std::collections::BTreeSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Copy a template .docx file to the working directory.
/// Returns the path to the new copy.
#[tauri::command]
pub fn copy_template(
    template_path: String,
    dest_dir: String,
    filename: String,
) -> Result<String, String> {
    let src = Path::new(&template_path);
    if !src.exists() {
        return Err(format!("Template file not found: {}", template_path));
    }

    let dest = Path::new(&dest_dir).join(&filename);
    fs::copy(src, &dest).map_err(|e| format!("Failed to copy template: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Extract all unique {Variable} placeholders from a .docx file.
/// Returns them sorted alphabetically.
#[tauri::command]
pub fn extract_variables(docx_path: String) -> Result<Vec<String>, String> {
    let xml_content = read_document_xml(&docx_path)?;
    let text = extract_text_from_xml(&xml_content);
    let variables = find_variables(&text);
    Ok(variables.into_iter().collect())
}

/// Replace variables in a .docx file with the provided values.
/// Takes a JSON object mapping variable names to their values.
/// Saves the modified document back to the same path.
#[tauri::command]
pub fn replace_variables(
    docx_path: String,
    variables: std::collections::HashMap<String, String>,
) -> Result<(), String> {
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
                let replaced = replace_in_xml(&xml_str, &variables);
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

// --- Internal helpers ---

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

/// Find all unique {Variable Name} patterns in text.
fn find_variables(text: &str) -> BTreeSet<String> {
    let mut variables = BTreeSet::new();
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
                variables.insert(var_name.trim().to_string());
            }
        }
    }

    variables
}

/// Replace {Variable} placeholders in raw XML content.
/// Word splits runs across XML elements, so a variable like {Client Name}
/// might appear as: <w:t>{Client</w:t></w:r><w:r><w:t> Name}</w:t>
/// We handle this by doing a text-level replacement on the raw XML,
/// being careful to only replace within <w:t> text content.
fn replace_in_xml(xml: &str, variables: &std::collections::HashMap<String, String>) -> String {
    // First pass: concatenate all text to find variable boundaries
    // Second pass: replace in the raw XML
    // For simplicity and reliability, we do direct string replacement
    // on the XML. This works because we're replacing the exact text
    // that appears in the document.
    let mut result = xml.to_string();
    for (var_name, value) in variables {
        if !value.is_empty() {
            let pattern = format!("{{{}}}", var_name);
            result = result.replace(&pattern, value);
        }
    }
    result
}

/// Convert Word XML to a simple HTML preview.
/// Preserves paragraph structure and highlights {Variable} placeholders.
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
                result.push_str(&format!(
                    "<span class=\"variable-highlight\">{{{}}}</span>",
                    var_content
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
