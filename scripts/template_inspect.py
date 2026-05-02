#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
Inspect a Lily DOCX template — extract and display all SDTs, bookmarks,
{Variable} placeholders, and their structure.

Usage:
	python template_inspect.py <template.docx> [--json] [--schema]

Options:
	--json     Output as JSON instead of human-readable text
	--schema   Also display the .lily sidecar schema if it exists
"""

import argparse
import json
import sys
from pathlib import Path

# Allow running from scripts/ or repo root
sys.path.insert(0, str(Path(__file__).parent))
import docx_utils


def inspect_template(docx_path: str, show_schema: bool = False) -> dict:
	"""
	Inspect a template and return a structured report.

	Returns a dict with:
	- variables: list of VariableInfo dicts
	- sdts: list of SDTInfo dicts (per XML part)
	- bookmarks: list of BookmarkInfo dicts (per XML part)
	- placeholders: list of PlaceholderInfo dicts (unconverted {Variable} text)
	- ids: dict with max_id and id_list
	- schema: the .lily sidecar schema (if show_schema and exists)
	"""
	parts = docx_utils.read_docx_xml_parts(docx_path)

	all_sdts = []
	all_bookmarks = []
	all_placeholders = []
	all_ids = set()

	for part_name, xml in parts.items():
		normalized = docx_utils.normalize_split_variables(xml)

		sdts = docx_utils.find_sdts(normalized, part_name)
		bookmarks = docx_utils.find_bookmarks(normalized, part_name)
		placeholders = docx_utils.find_placeholders(normalized, part_name)

		all_sdts.extend(sdts)
		all_bookmarks.extend(bookmarks)
		all_placeholders.extend(placeholders)

		# Collect IDs
		for sdt in sdts:
			if sdt.sdt_id is not None:
				all_ids.add(sdt.sdt_id)
		for bm in bookmarks:
			all_ids.add(bm.bookmark_id)

	# Extract variables (the merged, deduplicated view)
	variables = docx_utils.extract_variables(docx_path)

	report = {
		"file": docx_path,
		"variables": [v.to_dict() for v in variables],
		"sdts": [s.to_dict() for s in all_sdts],
		"bookmarks": [b.to_dict() for b in all_bookmarks],
		"placeholders": [p.to_dict() for p in all_placeholders],
		"ids": {
			"max_id": max(all_ids) if all_ids else 0,
			"count": len(all_ids),
			"ids": sorted(all_ids),
		},
		"summary": {
			"sdt_count": len(all_sdts),
			"bookmark_count": len(all_bookmarks),
			"placeholder_count": len(all_placeholders),
			"variable_count": len(variables),
			"conditional_count": sum(1 for v in variables if v.is_conditional),
			"parts_with_content": list(parts.keys()),
		},
	}

	if show_schema:
		schema = docx_utils.load_template_schema(docx_path)
		report["schema"] = schema

	return report


def print_report(report: dict) -> None:
	"""Print a human-readable inspection report."""
	print(f"Template: {report['file']}")
	summary = report["summary"]
	print(f"  XML parts: {', '.join(summary['parts_with_content'])}")
	print()

	# Variables summary
	print(f"Variables ({summary['variable_count']} total, {summary['conditional_count']} conditional):")
	print(f"  SDTs: {summary['sdt_count']}  |  Bookmarks: {summary['bookmark_count']}  |  Placeholders: {summary['placeholder_count']}")
	print()

	if report["variables"]:
		print("─── Variables (merged view) ───")
		for var in report["variables"]:
			kind = "COND" if var["is_conditional"] else "REPL"
			variants_str = ", ".join(f'"{v}"' for v in var["variants"])
			print(f"  [{kind}] {var['display_name']}")
			if len(var["variants"]) > 1 or var["variants"][0] != var["display_name"]:
				print(f"         variants: {variants_str}")
		print()

	if report["sdts"]:
		print("─── SDTs ───")
		for sdt in report["sdts"]:
			cond = " (conditional)" if sdt["is_conditional"] else ""
			content_preview = sdt["content_text"][:50]
			if len(sdt["content_text"]) > 50:
				content_preview += "..."
			print(f"  [{sdt['part_name']}] id={sdt['sdt_id']} {sdt['tag']}{cond}")
			print(f"         content: {content_preview!r}")
		print()

	if report["bookmarks"]:
		print("─── Bookmarks (empty-value placeholders) ───")
		for bm in report["bookmarks"]:
			cond = " (conditional)" if bm["is_conditional"] else ""
			print(f"  [{bm['part_name']}] id={bm['bookmark_id']} {bm['name']}{cond}")
		print()

	if report["placeholders"]:
		print("─── Unconverted Placeholders ───")
		for ph in report["placeholders"]:
			cond = " (conditional)" if ph["is_conditional"] else ""
			print(f"  [{ph['part_name']}] {ph['raw_text']}{cond}")
			print(f"         display: {ph['display_name']}")
		print()

	if report.get("schema"):
		schema = report["schema"]
		print("─── Schema (.lily sidecar) ───")
		print(f"  template_filename: {schema.get('template_filename', 'N/A')}")
		schema_vars = schema.get("variables", {})
		if schema_vars:
			for name, entry in schema_vars.items():
				var_type = entry.get("var_type", "text")
				required = entry.get("required", False)
				req_str = " REQUIRED" if required else ""
				help_text = entry.get("help", "")
				help_str = f'  help="{help_text}"' if help_text else ""
				print(f"  {name}: {var_type}{req_str}{help_str}")

				# Show conditional defs
				if entry.get("condition"):
					cond = entry["condition"]
					print(f'         true: "{cond.get("true_template", "")}"')
					print(f'         false: "{cond.get("false_template", "")}"')
				for i, cond in enumerate(entry.get("conditions", [])):
					print(f'         [{i}] true: "{cond.get("true_template", "")}"')
					print(f'         [{i}] false: "{cond.get("false_template", "")}"')
		else:
			print("  (no variables defined in schema)")
		print()

	# ID summary
	ids = report["ids"]
	print(f"IDs: {ids['count']} in use, max={ids['max_id']}, next available={ids['max_id'] + 1}")


def main():
	parser = argparse.ArgumentParser(
		description="Inspect a Lily DOCX template's SDTs, bookmarks, and variables.",
	)
	parser.add_argument("docx_path", help="Path to the .docx template file")
	parser.add_argument("--json", action="store_true", help="Output as JSON")
	parser.add_argument("--schema", action="store_true", help="Include .lily sidecar schema")
	args = parser.parse_args()

	if not Path(args.docx_path).exists():
		print(f"Error: File not found: {args.docx_path}", file=sys.stderr)
		sys.exit(1)

	report = inspect_template(args.docx_path, show_schema=args.schema)

	if args.json:
		print(json.dumps(report, indent="\t"))
	else:
		print_report(report)


if __name__ == "__main__":
	main()
