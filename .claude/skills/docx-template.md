---
name: docx-template
description: Edit Lily DOCX templates using SDT tooling scripts for reliable structured document tag manipulation, variable insertion/removal, schema sync, and validation.
trigger: TRIGGER when: user asks to edit, create, modify, inspect, or validate a DOCX template; user mentions SDTs, structured document tags, content controls, template variables, or .lily schema files; user asks to add/remove variables from a template; working with files in a templates directory.
---

# Lily DOCX Template Editing

You have access to Python tooling scripts in `scripts/` that reliably manipulate DOCX templates. **Always use these tools instead of manually editing DOCX XML.** Manual XML editing is error-prone — these tools handle ID generation, namespace correctness, run property preservation, and structural integrity automatically.

## Available Tools

All tools are in the `scripts/` directory of this repo. Run with `python3 scripts/<tool>.py`.

### `template_inspect.py` — Inspect a template (read-only)
```bash
python3 scripts/template_inspect.py <template.docx> [--json] [--schema]
```
Shows all SDTs, bookmarks, unconverted `{Variable}` placeholders, variable inventory, and IDs. Use `--schema` to also display the `.lily` sidecar. Use `--json` for structured output.

**Always run this first** before making any changes to understand the current state.

### `template_validate.py` — Validate structural integrity
```bash
python3 scripts/template_validate.py <template.docx> [--json]
```
Checks for: malformed SDTs, duplicate IDs, unconverted placeholders, schema drift, conditional classification inconsistency. Returns exit code 1 if errors found.

**Always run this after making changes** to verify correctness.

### `template_insert_sdt.py` — Insert a variable SDT
```bash
python3 scripts/template_insert_sdt.py <template.docx> <search_text> <variable_name> [options]
```
Options:
- `--occurrence N` — replace only the Nth occurrence (0-based, per XML part)
- `--replace-all` — replace all occurrences across all parts
- `--conditional` — use `lily-cond:` prefix instead of `lily:`
- `--dry-run` — preview without writing

If multiple occurrences exist and neither `--occurrence` nor `--replace-all` is specified, the tool will list occurrences and ask you to choose.

### `template_remove_sdt.py` — Remove a variable SDT
```bash
python3 scripts/template_remove_sdt.py <template.docx> <variable_name> <replacement_text> [options]
```
Options:
- `--occurrence N` — remove only the Nth occurrence (0-based, per XML part)
- `--dry-run` — preview without writing

Replaces the SDT with a plain `<w:r>` run containing the replacement text, preserving run properties (bold, italic, etc.).

### `template_schema_sync.py` — Sync .lily schema sidecar
```bash
python3 scripts/template_schema_sync.py <template.docx> [--dry-run] [--overwrite] [--json]
```
Generates or updates the `.lily` sidecar schema from the template's current SDT/bookmark inventory. Preserves existing metadata (help text, required flags, defaults) unless `--overwrite` is specified.

## Standard Workflow

When editing a template, always follow this sequence:

1. **Inspect** — `template_inspect.py` to understand current state
2. **Make changes** — `template_insert_sdt.py` / `template_remove_sdt.py`
3. **Validate** — `template_validate.py` to check for issues
4. **Sync schema** — `template_schema_sync.py` to update the `.lily` sidecar
5. **Re-validate** — `template_validate.py` to confirm schema is in sync

## Lily SDT Format Reference

### SDT Structure
Lily uses Word Structured Document Tags (SDTs) as content controls:
```xml
<w:sdt>
  <w:sdtPr>
    <w:id w:val="{unique_id}"/>
    <w:tag w:val="lily:{Variable Name}"/>
    <w:alias w:val="{Variable Name}"/>
  </w:sdtPr>
  <w:sdtContent>
    <w:r>{run_properties}<w:t xml:space="preserve">{value}</w:t></w:r>
  </w:sdtContent>
</w:sdt>
```

### Tag Prefixes
- `lily:` — simple replacement variables
- `lily-cond:` — conditional (ternary) variables

### Empty Values → Bookmarks
When a variable's value is empty, SDTs convert to zero-width bookmarks:
```xml
<w:bookmarkStart w:id="{id}" w:name="lily:{Variable Name}"/>
<w:bookmarkEnd w:id="{id}"/>
```

### ID Rules
- IDs are shared between SDTs and bookmarks — they must not collide
- Always scan all XML parts (document.xml, header*.xml, footer*.xml) to find the max ID
- New IDs increment from max + 1

### Variable Types
- **Replacement**: `{Variable Name}` — direct text substitution, case-aware
- **Conditional**: `{Label ?? "true text" :: "false text"}` — ternary toggle
- **Contact-role**: `{Role.property}` — auto-fills from contact data (e.g., `{Healthcare POA Agent.full_name}`)

### Casing Rules
- `{CLIENT FULL NAME}` + value "Jane Doe" → "JANE DOE"
- `{client full name}` + value "Jane Doe" → "jane doe"
- `{Client Full Name}` + value "Jane Doe" → "Jane Doe" (as-is)

### Schema Sidecar (.lily)
Each template can have a `.lily` JSON sidecar with variable metadata:
```json
{
  "lily_type": "template-schema",
  "template_filename": "Template Name.docx",
  "variables": {
    "Variable Name": {
      "var_type": "text",
      "required": true,
      "help": "Description shown to user"
    }
  }
}
```
Variable types: `text` (default), `date`, `currency`, `conditional`.

## Common Pitfalls to Avoid

1. **Never manually construct SDT XML** — use `template_insert_sdt.py`
2. **Never hardcode IDs** — the tools handle ID generation by scanning all parts
3. **Word splits variables across runs** — `{Client` in one run, `Name}` in another. The tools handle normalization automatically.
4. **Smart quotes** — Word auto-converts `"` to `"` `"`. The tools normalize these.
5. **XML escaping order matters** — `&` must be escaped before `<`, `>`, etc. Use the tools.
6. **Schema must stay in sync** — after any SDT changes, run `template_schema_sync.py`

## Parity with Rust Backend

These Python tools maintain exact parity with the Rust backend in `backend/src/docx_ops.rs`. The same SDT format, ID management, normalization, and escaping logic is used. If you discover a bug or add a feature to the Python tools, the Rust backend likely needs the same change (and vice versa).
