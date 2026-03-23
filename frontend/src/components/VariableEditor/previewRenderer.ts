import {
	VARIABLE_SPAN_RE,
	CONDITIONAL_SPAN_RE,
	applyCasing,
	parseConditionalDef,
	resolveNestedVariables,
} from "./variableHelpers";

/**
 * Build a live preview by replacing variable placeholders in the HTML.
 * Handles both replacement variables and conditional variables.
 * Red = unfilled, yellow = selected, green = filled & not selected.
 */
export function renderLivePreview(
	documentHtml: string,
	variableValues: Record<string, string>,
	selectedVariable: string | null,
	canonicalToDisplay: Record<string, string>,
	conditionalDefs: Record<string, string[]>,
): string {
	// Track occurrence counters for SDT-filled conditional spans
	// so each occurrence maps to its corresponding definition.
	const sdtOccurrenceCounts: Record<string, number> = {};

	// First pass: replace conditional variable spans (from fresh {Placeholder} text)
	const withConditionals = documentHtml.replace(
		CONDITIONAL_SPAN_RE,
		(
			match,
			canonicalKey: string,
			_originalCase: string,
			trueText: string,
			falseText: string,
		) => {
			const displayName = canonicalToDisplay[canonicalKey];
			if (!displayName) return match;

			const value = variableValues[displayName] ?? "false";
			const isTrue = value === "true";
			const branchText = isTrue ? trueText : falseText;
			const resolvedText = resolveNestedVariables(
				branchText,
				canonicalToDisplay,
			);
			const isSelected = displayName === selectedVariable;

			if (!resolvedText) {
				if (isSelected) {
					return `<span class="variable-highlight selected" data-variable="${canonicalKey}" data-original-case="${_originalCase}">&nbsp;</span>`;
				}
				return "";
			}

			const cssClass = isSelected
				? "variable-highlight selected"
				: "variable-highlight filled";
			return `<span class="${cssClass}" data-variable="${canonicalKey}" data-original-case="${_originalCase}">${resolvedText}</span>`;
		},
	);

	// Second pass: replace SDT-filled spans AND bookmark spans for
	// conditional variables in a single pass (document order matters for
	// matching definitions).  Uses a combined regex so occurrence counters
	// stay correct across interleaved SDTs and bookmarks.
	const COMBINED_SDT_BM_RE =
		/<span class="variable-(?:highlight filled|bookmark)" data-variable="([^"]*)" data-original-case="([^"]*)">[^<]*<\/span>/g;

	const withSdtConditionals = withConditionals.replace(
		COMBINED_SDT_BM_RE,
		(
			match,
			canonicalKey: string,
			originalCase: string,
		) => {
			const displayName = canonicalToDisplay[canonicalKey];
			if (!displayName) return match;

			// Check if this is a conditional variable
			const defs = conditionalDefs[displayName];
			if (!defs || defs.length === 0) {
				// Not conditional — leave as-is for the regular pass
				return match;
			}

			// Get the Nth definition for this label
			const idx = sdtOccurrenceCounts[displayName] ?? 0;
			sdtOccurrenceCounts[displayName] = idx + 1;
			const def = defs[idx] ?? defs[0];

			// Parse the definition to get true/false text
			const parsed = parseConditionalDef(def);
			if (!parsed) return match;
			const { trueText, falseText } = parsed;

			const value = variableValues[displayName] ?? "false";
			const isTrue = value === "true";
			const branchText = isTrue ? trueText : falseText;
			const resolvedText = resolveNestedVariables(
				branchText,
				canonicalToDisplay,
			);
			const isSelected = displayName === selectedVariable;

			if (!resolvedText) {
				if (isSelected) {
					return `<span class="variable-highlight selected" data-variable="${canonicalKey}" data-original-case="${originalCase}">&nbsp;</span>`;
				}
				return "";
			}

			const cssClass = isSelected
				? "variable-highlight selected"
				: "variable-highlight filled";
			return `<span class="${cssClass}" data-variable="${canonicalKey}" data-original-case="${originalCase}">${resolvedText}</span>`;
		},
	);

	// Third pass: replace regular (replacement) variable spans
	return withSdtConditionals.replace(
		VARIABLE_SPAN_RE,
		(match, canonicalKey: string, originalCase: string) => {
			const displayName = canonicalToDisplay[canonicalKey];
			if (!displayName) return match;

			const value = variableValues[displayName] ?? "";
			const isSelected = displayName === selectedVariable;

			if (isSelected) {
				const display = value
					? applyCasing(value, originalCase)
					: `{${originalCase}}`;
				return `<span class="variable-highlight selected" data-variable="${canonicalKey}" data-original-case="${originalCase}">${display}</span>`;
			}
			if (value) {
				const display = applyCasing(value, originalCase);
				return `<span class="variable-highlight filled" data-variable="${canonicalKey}" data-original-case="${originalCase}">${display}</span>`;
			}
			// Unfilled and not selected — leave as-is (base red styling)
			return match;
		},
	);
}
