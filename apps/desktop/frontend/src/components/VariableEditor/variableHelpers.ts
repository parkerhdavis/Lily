import type { VariableInfo, Contact } from "@/types";
import { extractFilename } from "@/utils/path";

/**
 * Fuzzy-filter a list of variables by a search query.
 * The query is split into whitespace-separated tokens. A variable matches
 * if every token appears (case-insensitive) in either the variable name
 * or its current value.
 */
export function fuzzyFilterVariables(
	variables: VariableInfo[],
	values: Record<string, string>,
	query: string,
): VariableInfo[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return variables;

	const tokens = trimmed.split(/\s+/);
	return variables.filter((v) => {
		const name = v.display_name.toLowerCase();
		const value = (values[v.display_name] ?? "").toLowerCase();
		return tokens.every((t) => name.includes(t) || value.includes(t));
	});
}

/** Extract the display filename (without .docx extension) from a full path. */
export function getDisplayName(docPath: string): string {
	return extractFilename(docPath).replace(/\.docx$/i, "");
}

/**
 * Apply casing transformation to a value based on the original variable casing.
 * ALL CAPS → uppercase, all lower → lowercase, otherwise as-is.
 */
export function applyCasing(value: string, originalCase: string): string {
	const alpha = originalCase.replace(/[^a-zA-Z]/g, "");
	if (!alpha) return value;

	const allUpper = alpha === alpha.toUpperCase();
	const allLower = alpha === alpha.toLowerCase();

	if (allUpper) return value.toUpperCase();
	if (allLower) return value.toLowerCase();
	return value;
}

/**
 * Regex that matches a replacement variable-highlight span (non-conditional).
 * Captures: [1] = canonical key, [2] = original case
 */
export const VARIABLE_SPAN_RE =
	/<span class="variable-highlight" data-variable="([^"]*)" data-original-case="([^"]*)">\{[^}]*\}<\/span>/g;

/**
 * Regex that matches a conditional variable-highlight span from fresh
 * {Placeholder} text.  Captures: [1] = canonical key, [2] = original case,
 * [3] = true text, [4] = false text
 */
export const CONDITIONAL_SPAN_RE =
	/<span class="variable-highlight[\s\w]*" data-variable="([^"]*)" data-original-case="([^"]*)" data-conditional="true" data-true-text="([^"]*)" data-false-text="([^"]*)">[\s\S]*?<\/span>/g;

/**
 * Regex that matches an SDT-generated variable-highlight span (from a
 * previously saved document).  These do NOT have data-conditional attributes;
 * the conditional logic is handled using definitions from the .lily file.
 * Captures: [1] = canonical key, [2] = original case, [3] = current text
 */
export const SDT_FILLED_SPAN_RE =
	/<span class="variable-highlight filled" data-variable="([^"]*)" data-original-case="([^"]*)">([^<]*)<\/span>/g;

/**
 * Regex that matches a bookmark-generated zero-width anchor span (from a
 * previously saved empty conditional).  These are invisible by default but
 * need to be expanded when the conditional is toggled to true.
 * Captures: [1] = canonical key, [2] = original case
 */
export const BOOKMARK_SPAN_RE =
	/<span class="variable-bookmark" data-variable="([^"]*)" data-original-case="([^"]*)"><\/span>/g;

/**
 * Normalize smart / curly quotes to plain ASCII double quotes.
 *
 * Word's "AutoFormat as you type" automatically converts straight quotes
 * (`"`) to left/right curly quotes (\u201C / \u201D).  This helper
 * ensures the conditional parser accepts both forms.
 */
export function normalizeQuotes(s: string): string {
	return s
		.replace(/\u201C/g, '"')
		.replace(/\u201D/g, '"')
		.replace(/\u2018/g, "'")
		.replace(/\u2019/g, "'");
}

/**
 * Parse a conditional definition string into its true/false branch text.
 * Expected syntax: `Label ?? "true text" :: "false text"`
 * Both branch texts must be wrapped in double quotes (straight or smart).
 */
/** Find the index of the first unescaped double-quote in `s`. */
function findUnescapedQuote(s: string): number {
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length) {
			i++; // skip escaped character
		} else if (s[i] === '"') {
			return i;
		}
	}
	return -1;
}

export function parseConditionalDef(
	def: string,
): { trueText: string; falseText: string } | null {
	const normalized = normalizeQuotes(def);
	const qqIdx = normalized.indexOf(" ?? ");
	if (qqIdx < 0) return null;
	const rest = normalized.substring(qqIdx + 4).trim();

	if (!rest.startsWith('"')) return null;
	const inner = rest.substring(1);
	const closeIdx = findUnescapedQuote(inner);
	if (closeIdx < 0) return null;
	const trueText = inner.substring(0, closeIdx).replaceAll('\\"', '"');

	let remainder = inner.substring(closeIdx + 1).trim();
	let falseText = "";
	if (remainder.startsWith("::")) {
		remainder = remainder.substring(2).trim();
		if (remainder.startsWith('"')) {
			const falseInner = remainder.substring(1);
			const falseClose = findUnescapedQuote(falseInner);
			if (falseClose >= 0) {
				falseText = falseInner.substring(0, falseClose).replaceAll('\\"', '"');
			}
		}
	}
	return { trueText, falseText };
}

/** Known contact property keys matching the Rust Contact struct. */
export const CONTACT_PROPERTIES = new Set([
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
]);

/** Property key → human label. */
export const PROPERTY_LABELS: Record<string, string> = {
	full_name: "Full Name",
	first_name: "First Name",
	last_name: "Last Name",
	relationship: "Relationship",
	phone: "Phone",
	email: "Email",
	address: "Address",
	city: "City",
	state: "State",
	zip: "ZIP",
};

/**
 * Try to parse a variable variant as contact-role dot notation.
 * Returns { role, property } if the variant matches `Role.property`.
 */
export function parseContactRoleVariant(
	variant: string,
): { role: string; property: string } | null {
	const dotIdx = variant.lastIndexOf(".");
	if (dotIdx < 0) return null;
	const role = variant.substring(0, dotIdx).trim();
	const property = variant.substring(dotIdx + 1).trim().toLowerCase();
	if (!role || !CONTACT_PROPERTIES.has(property)) return null;
	return { role, property };
}

/** Read a contact property by key. */
export function getContactProperty(contact: Contact, key: string): string {
	return (contact as unknown as Record<string, string>)[key] ?? "";
}

/** Info about a contact-role group (all variables sharing a role). */
export interface ContactRoleGroup {
	role: string;
	properties: { displayName: string; property: string }[];
}

/**
 * Wrap `{Variable Name}` placeholders in a text string with variable-highlight
 * spans so the third pass of getLivePreviewHtml can resolve values, apply
 * selected/filled state, and make them individually clickable in the preview.
 */
export function resolveNestedVariables(
	text: string,
	canonicalToDisplay: Record<string, string>,
): string {
	return text.replace(/\{([^}]+)\}/g, (_match, innerName: string) => {
		const trimmed = innerName.trim();
		// Map contact-role dot notation to flat canonical key
		const parsed = parseContactRoleVariant(trimmed);
		const canonical = parsed
			? `${parsed.role} ${PROPERTY_LABELS[parsed.property] ?? parsed.property}`.toLowerCase()
			: trimmed.toLowerCase();
		const displayName = canonicalToDisplay[canonical];
		if (!displayName) return _match;
		// Wrap in a variable-highlight span matching the VARIABLE_SPAN_RE
		// format so the third pass handles value resolution and selection state.
		return `<span class="variable-highlight" data-variable="${canonical}" data-original-case="${trimmed}">{${trimmed}}</span>`;
	});
}
