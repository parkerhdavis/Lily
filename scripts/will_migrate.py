#!/usr/bin/env python3
"""
One-shot migration script for the Will templates (Last Will and Pour Over Will).

Renames Personal Representative and Guardian variables to new naming
and adds co-agent helper variable SDTs for Personal Representatives.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import docx_utils


def replace_sdt_by_tag(xml: str, old_tag: str, new_sdts_xml: str) -> str:
	"""Find an SDT by its exact tag value and replace it with new XML."""
	tag_str = f'w:tag w:val="{old_tag}"'
	pos = xml.find(tag_str)
	if pos < 0:
		print(f"  WARNING: tag '{old_tag}' not found")
		return xml
	sdt_start = xml.rfind("<w:sdt>", 0, pos)
	sdt_end = xml.index("</w:sdt>", pos) + len("</w:sdt>")
	return xml[:sdt_start] + new_sdts_xml + xml[sdt_end:]


def extract_rpr(xml: str, tag: str) -> str:
	"""Extract the rPr from an SDT's content runs."""
	pos = xml.find(f'w:tag w:val="{tag}"')
	if pos < 0:
		return ""
	sdt_start = xml.rfind("<w:sdt>", 0, pos)
	sdt_end = xml.index("</w:sdt>", pos) + len("</w:sdt>")
	sdt = xml[sdt_start:sdt_end]
	match = re.search(r'<w:sdtContent>.*?(<w:rPr>.*?</w:rPr>)', sdt, re.DOTALL)
	return match.group(1) if match else ""


def migrate(docx_path: str) -> None:
	entries = docx_utils.read_docx_entries(docx_path)
	next_id = docx_utils.find_max_id_across_parts(entries) + 1

	for i, (name, content) in enumerate(entries):
		if name != "word/document.xml":
			continue

		xml = content.decode("utf-8")

		# ── Step 1: Personal Representative Full Name → Primary Personal Representative Full Name
		#            + Primary Co-Personal Representative And Name
		rpr = extract_rpr(xml, "lily:Personal Representative Full Name")
		rpr_no_caps = re.sub(r'<w:caps/>', '', rpr)

		new_xml = docx_utils.make_sdt_xml(
			next_id, "Primary Personal Representative Full Name",
			"Primary Personal Representative Full Name", False, rpr,
		)
		next_id += 1
		new_xml += docx_utils.make_sdt_xml(
			next_id, "Primary Co-Personal Representative And Name",
			"Primary Co-Personal Representative And Name", False, rpr_no_caps,
		)
		next_id += 1
		xml = replace_sdt_by_tag(xml, "lily:Personal Representative Full Name", new_xml)
		print("  Replaced Personal Representative Full Name → Primary + Co-PR And Name")

		# ── Step 2: Has Alternate Personal Representative → Has Secondary Personal Representative
		rpr = extract_rpr(xml, "lily-cond:Has Alternate Personal Representative")
		new_xml = docx_utils.make_sdt_xml(
			next_id, "Has Secondary Personal Representative",
			"Has Secondary Personal Representative", True, rpr,
		)
		next_id += 1
		xml = replace_sdt_by_tag(xml, "lily-cond:Has Alternate Personal Representative", new_xml)
		print("  Replaced Has Alternate Personal Representative → Has Secondary Personal Representative")

		# ── Step 3: Has Third Personal Representative → Has Tertiary Personal Representative
		rpr = extract_rpr(xml, "lily-cond:Has Third Personal Representative")
		new_xml = docx_utils.make_sdt_xml(
			next_id, "Has Tertiary Personal Representative",
			"Has Tertiary Personal Representative", True, rpr,
		)
		next_id += 1
		xml = replace_sdt_by_tag(xml, "lily-cond:Has Third Personal Representative", new_xml)
		print("  Replaced Has Third Personal Representative → Has Tertiary Personal Representative")

		# ── Step 4: Has Minor Children — update Guardian references in the template library
		#            (the SDT tag stays the same, just the branch text in the library changes)
		#            No template XML change needed here.

		entries[i] = (name, xml.encode("utf-8"))
		break

	docx_utils.write_docx(docx_path, entries)

	variables = docx_utils.extract_variables(docx_path)
	print("\nMigration complete. Variables:")
	for v in variables:
		prefix = "[COND]" if v.is_conditional else "[REPL]"
		print(f"  {prefix} {v.display_name}")


if __name__ == "__main__":
	if len(sys.argv) != 2:
		print(f"Usage: {sys.argv[0]} <template.docx>")
		sys.exit(1)
	migrate(sys.argv[1])
