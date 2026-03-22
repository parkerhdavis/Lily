import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import SectionHeading from "@/components/ui/SectionHeading";
import StatusDot from "@/components/ui/StatusDot";
import AppSwitcher from "@/components/ui/AppSwitcher";
import type { VariableInfo, Contact } from "@/types";

/**
 * Fuzzy-filter a list of variables by a search query.
 * The query is split into whitespace-separated tokens. A variable matches
 * if every token appears (case-insensitive) in either the variable name
 * or its current value.
 */
function fuzzyFilterVariables(
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
function getDisplayName(docPath: string): string {
	const filename =
		docPath.split("/").pop() ?? docPath.split("\\").pop() ?? docPath;
	return filename.replace(/\.docx$/i, "");
}

/**
 * Apply casing transformation to a value based on the original variable casing.
 * ALL CAPS → uppercase, all lower → lowercase, otherwise as-is.
 */
function applyCasing(value: string, originalCase: string): string {
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
const VARIABLE_SPAN_RE =
	/<span class="variable-highlight" data-variable="([^"]*)" data-original-case="([^"]*)">\{[^}]*\}<\/span>/g;

/**
 * Regex that matches a conditional variable-highlight span from fresh
 * {Placeholder} text.  Captures: [1] = canonical key, [2] = original case,
 * [3] = true text, [4] = false text
 */
const CONDITIONAL_SPAN_RE =
	/<span class="variable-highlight[\s\w]*" data-variable="([^"]*)" data-original-case="([^"]*)" data-conditional="true" data-true-text="([^"]*)" data-false-text="([^"]*)">[\s\S]*?<\/span>/g;

/**
 * Regex that matches an SDT-generated variable-highlight span (from a
 * previously saved document).  These do NOT have data-conditional attributes;
 * the conditional logic is handled using definitions from the .lily file.
 * Captures: [1] = canonical key, [2] = original case, [3] = current text
 */
const SDT_FILLED_SPAN_RE =
	/<span class="variable-highlight filled" data-variable="([^"]*)" data-original-case="([^"]*)">([^<]*)<\/span>/g;

/**
 * Regex that matches a bookmark-generated zero-width anchor span (from a
 * previously saved empty conditional).  These are invisible by default but
 * need to be expanded when the conditional is toggled to true.
 * Captures: [1] = canonical key, [2] = original case
 */
const BOOKMARK_SPAN_RE =
	/<span class="variable-bookmark" data-variable="([^"]*)" data-original-case="([^"]*)"><\/span>/g;

/**
 * Normalize smart / curly quotes to plain ASCII double quotes.
 *
 * Word's "AutoFormat as you type" automatically converts straight quotes
 * (`"`) to left/right curly quotes (\u201C / \u201D).  This helper
 * ensures the conditional parser accepts both forms.
 */
function normalizeQuotes(s: string): string {
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
function parseConditionalDef(
	def: string,
): { trueText: string; falseText: string } | null {
	const normalized = normalizeQuotes(def);
	const qqIdx = normalized.indexOf(" ?? ");
	if (qqIdx < 0) return null;
	const rest = normalized.substring(qqIdx + 4).trim();

	if (!rest.startsWith('"')) return null;
	const closeIdx = rest.indexOf('"', 1);
	if (closeIdx < 0) return null;
	const trueText = rest.substring(1, closeIdx);

	let remainder = rest.substring(closeIdx + 1).trim();
	let falseText = "";
	if (remainder.startsWith("::")) {
		remainder = remainder.substring(2).trim();
		if (remainder.startsWith('"') && remainder.endsWith('"')) {
			falseText = remainder.substring(1, remainder.length - 1);
		}
	}
	return { trueText, falseText };
}

/**
 * Resolve `{Variable Name}` placeholders in a text string using the current
 * variable values and canonical-to-display name mapping. Used to fill in
 * nested replacement variables inside conditional text branches.
 */
function resolveNestedVariables(
	text: string,
	variableValues: Record<string, string>,
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
		const value = variableValues[displayName] ?? "";
		if (!value) return _match;
		return applyCasing(value, trimmed);
	});
}

/** Known contact property keys matching the Rust Contact struct. */
const CONTACT_PROPERTIES = new Set([
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
const PROPERTY_LABELS: Record<string, string> = {
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
function parseContactRoleVariant(
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
function getContactProperty(contact: Contact, key: string): string {
	return (contact as unknown as Record<string, string>)[key] ?? "";
}

/** Info about a contact-role group (all variables sharing a role). */
interface ContactRoleGroup {
	role: string;
	properties: { displayName: string; property: string }[];
}

export default function VariableEditor() {
	const {
		variables,
		variableValues,
		documentHtml,
		documentPath,
		dirty,
		loading,
		error,
		lilyFile,
		updateVariable,
		renameDocument,
		saveDocument,
		setContactBinding,
		clearContactBinding,
		setRoleOverride,
		returnToHub,
	} = useWorkflowStore();

	// Current document filename (for looking up per-document overrides)
	const currentFilename = useMemo(() => {
		if (!documentPath) return null;
		return (
			documentPath.split("/").pop() ??
			documentPath.split("\\").pop() ??
			null
		);
	}, [documentPath]);

	// Per-document role overrides for the current document
	const roleOverrides = useMemo(() => {
		if (!currentFilename || !lilyFile?.documents[currentFilename])
			return {};
		return (
			lilyFile.documents[currentFilename].role_overrides ?? {}
		);
	}, [lilyFile, currentFilename]);

	const [selectedVariable, setSelectedVariable] = useState<string | null>(
		null,
	);
	const [varSearch, setVarSearch] = useState("");
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement>(null);
	const varSearchRef = useRef<HTMLInputElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const sidebarRef = useRef<HTMLDivElement>(null);
	// Track which occurrence index we're on per variable for prev/next navigation
	const [occurrenceIndex, setOccurrenceIndex] = useState<
		Record<string, number>
	>({});

	// Build a lookup from canonical (lowercase) key to display_name
	const canonicalToDisplay = useMemo(() => {
		const map: Record<string, string> = {};
		for (const v of variables) {
			map[v.display_name.toLowerCase()] = v.display_name;
		}
		return map;
	}, [variables]);

	// Detect contact-role variables from dot notation in variants.
	// Maps display_name → { role, property } for contact-role variables.
	const contactRoleVarMap = useMemo(() => {
		const map: Record<string, { role: string; property: string }> = {};
		for (const v of variables) {
			for (const variant of v.variants) {
				const parsed = parseContactRoleVariant(variant);
				if (parsed) {
					map[v.display_name] = parsed;
					break;
				}
			}
		}
		return map;
	}, [variables]);

	// Group contact-role variables by role, preserving document order.
	const contactRoleGroups = useMemo(() => {
		const groups: ContactRoleGroup[] = [];
		const seen = new Set<string>();
		for (const v of variables) {
			const info = contactRoleVarMap[v.display_name];
			if (!info) continue;
			if (!seen.has(info.role)) {
				seen.add(info.role);
				groups.push({ role: info.role, properties: [] });
			}
			const group = groups.find((g) => g.role === info.role);
			group?.properties.push({
				displayName: v.display_name,
				property: info.property,
			});
		}
		return groups;
	}, [variables, contactRoleVarMap]);

	// Set of display_names that belong to a contact-role group
	const contactRoleVarNames = useMemo(
		() => new Set(Object.keys(contactRoleVarMap)),
		[contactRoleVarMap],
	);

	// Focus the title input when entering edit mode
	useEffect(() => {
		if (editingTitle && titleInputRef.current) {
			titleInputRef.current.focus();
			titleInputRef.current.select();
		}
	}, [editingTitle]);

	// Ctrl+S / Cmd+S keyboard shortcut for saving
	// Ctrl+F / Cmd+F keyboard shortcut to focus variable search
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				if (!loading) {
					saveDocument();
				}
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "f") {
				e.preventDefault();
				varSearchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [loading, saveDocument]);

	// Handle clicks on variable highlights in the document preview
	const handlePreviewClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement;
			const span = target.closest<HTMLElement>(
				"[data-variable]",
			);
			if (!span) return;

			const canonical = span.dataset.variable;
			if (!canonical) return;

			const displayName = canonicalToDisplay[canonical];
			if (!displayName) return;

			// Select the variable and scroll its sidebar entry into view
			setSelectedVariable(displayName);
			const sidebarEl = sidebarRef.current?.querySelector(
				`[data-var-entry="${CSS.escape(displayName)}"]`,
			);
			if (sidebarEl) {
				sidebarEl.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				// Focus the input inside the entry if it's a text variable
				const input =
					sidebarEl.querySelector<HTMLInputElement>(
						"input[type=text]",
					);
				if (input) {
					setTimeout(() => input.focus(), 100);
				}
			}
		},
		[canonicalToDisplay],
	);

	// Scroll to a specific occurrence of a variable in the document preview
	const scrollToOccurrence = useCallback(
		(displayName: string, direction: "prev" | "next") => {
			if (!previewRef.current) return;
			const canonical = displayName.toLowerCase();
			const spans = Array.from(
				previewRef.current.querySelectorAll<HTMLElement>(
					`[data-variable="${CSS.escape(canonical)}"]`,
				),
			);
			if (spans.length === 0) return;

			const currentIdx = occurrenceIndex[displayName] ?? -1;
			let newIdx: number;
			if (direction === "next") {
				newIdx =
					currentIdx + 1 >= spans.length ? 0 : currentIdx + 1;
			} else {
				newIdx =
					currentIdx - 1 < 0
						? spans.length - 1
						: currentIdx - 1;
			}

			setOccurrenceIndex((prev) => ({
				...prev,
				[displayName]: newIdx,
			}));
			setSelectedVariable(displayName);

			spans[newIdx].scrollIntoView({
				behavior: "smooth",
				block: "center",
			});
		},
		[occurrenceIndex],
	);

	// Count occurrences of a variable in the preview
	const getOccurrenceCount = useCallback(
		(displayName: string): number => {
			if (!previewRef.current) return 0;
			const canonical = displayName.toLowerCase();
			return previewRef.current.querySelectorAll(
				`[data-variable="${CSS.escape(canonical)}"]`,
			).length;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[documentHtml, variableValues, selectedVariable],
	);

	const startEditingTitle = () => {
		if (!documentPath) return;
		setTitleDraft(getDisplayName(documentPath));
		setEditingTitle(true);
	};

	const commitTitle = async () => {
		setEditingTitle(false);
		const trimmed = titleDraft.trim();
		if (!trimmed || !documentPath) return;

		const currentName = getDisplayName(documentPath);
		if (trimmed === currentName) return;

		await renameDocument(trimmed);
	};

	const cancelEditingTitle = () => {
		setEditingTitle(false);
	};

	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			commitTitle();
		} else if (e.key === "Escape") {
			cancelEditingTitle();
		}
	};

	// Conditional definitions from the .lily file, keyed by display name.
	const conditionalDefs = lilyFile?.conditional_definitions ?? {};

	// Build a live preview by replacing variable placeholders in the HTML.
	// Handles both replacement variables and conditional variables.
	// Red = unfilled, yellow = selected, green = filled & not selected.
	const getLivePreviewHtml = useCallback(() => {
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
					variableValues,
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
					variableValues,
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
	}, [documentHtml, variableValues, selectedVariable, canonicalToDisplay, conditionalDefs]);

	const handleVariableChange = (name: string, value: string) => {
		updateVariable(name, value);
	};

	const filteredVariables = useMemo(
		() => fuzzyFilterVariables(variables, variableValues, varSearch),
		[variables, variableValues, varSearch],
	);

	// Build a set of conditional variable names for quick lookup
	const conditionalVarNames = useMemo(() => {
		const set = new Set<string>();
		for (const v of variables) {
			if (v.is_conditional) set.add(v.display_name);
		}
		return set;
	}, [variables]);

	const filledCount = Object.entries(variableValues).filter(
		([name, v]) => conditionalVarNames.has(name) || v.length > 0,
	).length;

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<header className="flex items-center gap-4 px-5 py-3 border-b border-base-300 bg-base-100">
				<button
					type="button"
					className="btn btn-ghost btn-sm gap-1.5 text-base-content/70 hover:text-base-content"
					onClick={returnToHub}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						className="size-4"
					>
						<title>Back</title>
						<path
							fillRule="evenodd"
							d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
							clipRule="evenodd"
						/>
					</svg>
					Back
				</button>
				<div className="flex-1 min-w-0">
					{editingTitle ? (
						<input
							ref={titleInputRef}
							type="text"
							className="input input-bordered input-sm text-lg font-semibold w-full max-w-md"
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							onBlur={commitTitle}
							onKeyDown={handleTitleKeyDown}
						/>
					) : (
						<h2
							className="text-lg font-semibold truncate cursor-pointer hover:text-primary transition-colors"
							onDoubleClick={startEditingTitle}
							title="Double-click to rename"
						>
							{documentPath ? getDisplayName(documentPath) : ""}
							<span className="text-base-content/30 font-normal">
								.docx
							</span>
						</h2>
					)}
					<p className="text-xs text-base-content/50">
						{filledCount} of {variables.length} variables filled
					</p>
				</div>
				<div className="flex items-center gap-2">
					{dirty && (
						<span className="badge badge-warning badge-sm">
							Unsaved
						</span>
					)}
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={saveDocument}
						disabled={loading}
					>
						{loading ? (
							<span className="loading loading-spinner loading-xs" />
						) : (
							"Save"
						)}
					</button>
					<AppSwitcher />
				</div>
			</header>

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Main content: sidebar + preview */}
			<div className="flex flex-1 overflow-hidden">
				{/* Variable sidebar */}
				<div
					ref={sidebarRef}
					className="w-80 shrink-0 border-r border-base-300 overflow-y-auto p-4 bg-base-100 shadow-2xl"
				>
					<SectionHeading className="mb-3">
						Variables
					</SectionHeading>
				{variables.length > 0 && (
					<div className="pb-3 mb-3 border-b border-base-300">
						<input
							ref={varSearchRef}
							type="text"
							className="input input-bordered input-sm w-full"
							placeholder="Search variables... (Ctrl+F)"
							value={varSearch}
							onChange={(e) => setVarSearch(e.target.value)}
						/>
					</div>
				)}
				{variables.length === 0 ? (
					<p className="text-sm text-base-content/50">
						No variables found in this document.
					</p>
				) : filteredVariables.length === 0 ? (
					<p className="text-sm text-base-content/50">
						No variables match your search.
					</p>
				) : (
				<div className="flex flex-col gap-2">
					{(() => {
						const renderedRoles = new Set<string>();
						return filteredVariables.map((varInfo) => {
						const name = varInfo.display_name;

						// ── Conditional variable ──
						if (varInfo.is_conditional) {
							const isTrue =
								variableValues[name] === "true";
							return (
								<div
									key={name}
									data-var-entry={name}
									className="p-3 w-full rounded-lg border border-base-300 bg-base-100"
								>
									<div className="flex items-center justify-between mb-1.5">
										<span className="label-text text-sm font-medium">
											{name}
										</span>
										<div className="join">
											<button
												type="button"
												className="join-item btn btn-ghost btn-xs px-1"
												onClick={() =>
													scrollToOccurrence(
														name,
														"prev",
													)
												}
												title="Previous occurrence"
											>
												&lsaquo;
											</button>
											<button
												type="button"
												className="join-item btn btn-ghost btn-xs px-1"
												onClick={() =>
													scrollToOccurrence(
														name,
														"next",
													)
												}
												title="Next occurrence"
											>
												&rsaquo;
											</button>
										</div>
									</div>
									<div className="flex rounded-lg overflow-hidden border border-base-300">
										<button
											type="button"
											className={`flex-1 text-xs font-semibold py-1.5 transition-colors ${
												isTrue
													? "bg-success text-success-content"
													: "bg-base-200 text-base-content/40 hover:bg-base-300"
											}`}
											onClick={() => {
												handleVariableChange(
													name,
													"true",
												);
											}}
											onFocus={() =>
												setSelectedVariable(
													name,
												)
											}
											onBlur={() =>
												setSelectedVariable(
													null,
												)
											}
										>
											True
										</button>
										<button
											type="button"
											className={`flex-1 text-xs font-semibold py-1.5 transition-colors ${
												!isTrue
													? "bg-error text-error-content"
													: "bg-base-200 text-base-content/40 hover:bg-base-300"
											}`}
											onClick={() => {
												handleVariableChange(
													name,
													"false",
												);
											}}
											onFocus={() =>
												setSelectedVariable(
													name,
												)
											}
											onBlur={() =>
												setSelectedVariable(
													null,
												)
											}
										>
											False
										</button>
									</div>
								</div>
							);
						}

						// ── Contact-role variable ──
						const crInfo = contactRoleVarMap[name];
						if (crInfo) {
							// Render the group once at the first property
							if (renderedRoles.has(crInfo.role)) return null;
							renderedRoles.add(crInfo.role);
							const group = contactRoleGroups.find(
								(g) => g.role === crInfo.role,
							);
							if (!group) return null;
							return (
								<ContactRoleField
									key={`role:${group.role}`}
									group={group}
									contacts={lilyFile?.contacts ?? []}
									bindings={lilyFile?.contact_bindings ?? {}}
									variableValues={variableValues}
									isOverridden={group.role in roleOverrides}
									onToggleOverride={async (overriding) => {
										if (overriding) {
											// Snapshot current values as the override
											const values: Record<string, string> = {};
											for (const p of group.properties) {
												values[p.displayName] = variableValues[p.displayName] ?? "";
											}
											const binding = lilyFile?.contact_bindings?.[group.role];
											await setRoleOverride(group.role, {
												contact_id: binding?.contact_id ?? null,
												values,
											});
										} else {
											// Remove override — revert to questionnaire
											await setRoleOverride(group.role, null);
											// Restore questionnaire values into variableValues
											const savedVars = lilyFile?.variables ?? {};
											for (const p of group.properties) {
												handleVariableChange(p.displayName, savedVars[p.displayName] ?? "");
											}
										}
									}}
									onSelectContact={async (contactId) => {
										// Save as per-document override
										const values: Record<string, string> = {};
										const contact = contactId
											? (lilyFile?.contacts ?? []).find((c) => c.id === contactId)
											: null;
										for (const p of group.properties) {
											values[p.displayName] = contact
												? getContactProperty(contact, p.property)
												: "";
										}
										await setRoleOverride(group.role, {
											contact_id: contactId,
											values,
										});
										// Update live preview
										for (const [varName, value] of Object.entries(values)) {
											handleVariableChange(varName, value);
										}
									}}
									onManualChange={(varName, value) => {
										handleVariableChange(varName, value);
									}}
									onSelect={(varName) =>
										setSelectedVariable(varName)
									}
									onDeselect={() =>
										setSelectedVariable(null)
									}
									scrollToOccurrence={scrollToOccurrence}
								/>
							);
						}

						// ── Regular replacement variable ──
						const isFilled = Boolean(variableValues[name]);
						return (
							<div
								key={name}
								data-var-entry={name}
								className="p-3 w-full rounded-lg border border-base-300 bg-base-100"
							>
								<div className="flex items-center justify-between mb-1">
									<span className="label-text text-sm font-medium flex items-center gap-1.5">
										<StatusDot filled={isFilled} />
										{name}
									</span>
									<div className="join">
										<button
											type="button"
											className="join-item btn btn-ghost btn-xs px-1"
											onClick={() =>
												scrollToOccurrence(
													name,
													"prev",
												)
											}
											title="Previous occurrence"
										>
											&lsaquo;
										</button>
										<button
											type="button"
											className="join-item btn btn-ghost btn-xs px-1"
											onClick={() =>
												scrollToOccurrence(
													name,
													"next",
												)
											}
											title="Next occurrence"
										>
											&rsaquo;
										</button>
									</div>
								</div>
								<input
									type="text"
									className="input input-bordered input-sm w-full"
									placeholder={`Enter ${name}`}
									value={variableValues[name] ?? ""}
									onChange={(e) =>
										handleVariableChange(
											name,
											e.target.value,
										)
									}
									onFocus={() =>
										setSelectedVariable(name)
									}
									onBlur={() =>
										setSelectedVariable(null)
									}
								/>
							</div>
						);
					});
					})()}
				</div>
				)}
				</div>

				{/* Document preview */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: preview click selects variables */}
				<div
					className="flex-1 overflow-y-auto p-8 bg-base-200"
					onClick={handlePreviewClick}
				>
					<div
						ref={previewRef}
						className="bg-base-100 rounded-lg shadow-2xl border border-base-300 p-8 max-w-4xl mx-auto prose prose-sm"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: HTML preview from backend
						dangerouslySetInnerHTML={{
							__html: getLivePreviewHtml(),
						}}
					/>
				</div>
			</div>
		</div>
	);
}

// ─── Icons ──────────────────────────────────────────────────────────────────

function LinkIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 20 20"
			fill="currentColor"
			className={className ?? "size-4"}
		>
			<title>Linked</title>
			<path d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" />
			<path d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" />
		</svg>
	);
}

function LinkSlashIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 20 20"
			fill="currentColor"
			className={className ?? "size-4"}
		>
			<title>Unlinked</title>
			<path d="M.172 2.172a.586.586 0 0 1 .828 0l16.828 16.828a.586.586 0 0 1-.828.828L.172 3a.586.586 0 0 1 0-.828Z" />
			<path d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0-.036 5.612.75.75 0 1 0 1.06-1.06 2.5 2.5 0 0 1 .023-3.51l3.013-2.982Z" />
			<path d="M7.768 15.768a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 0 0 5.656 5.656l3-3a4 4 0 0 0 .036-5.612.75.75 0 0 0-1.06 1.06 2.5 2.5 0 0 1-.023 3.51l-3.013 2.982Z" />
		</svg>
	);
}

// ─── Contact-role field ─────────────────────────────────────────────────────

function ContactRoleField({
	group,
	contacts,
	bindings,
	variableValues,
	isOverridden,
	onToggleOverride,
	onSelectContact,
	onManualChange,
	onSelect,
	onDeselect,
	scrollToOccurrence,
}: {
	group: ContactRoleGroup;
	contacts: Contact[];
	bindings: Record<string, import("@/types").ContactBinding>;
	variableValues: Record<string, string>;
	isOverridden: boolean;
	onToggleOverride: (overriding: boolean) => Promise<void>;
	onSelectContact: (contactId: string | null) => Promise<void>;
	onManualChange: (varName: string, value: string) => void;
	onSelect: (varName: string) => void;
	onDeselect: () => void;
	scrollToOccurrence: (varName: string, direction: "prev" | "next") => void;
}) {
	// Questionnaire binding (source of truth when linked)
	const qBinding = bindings[group.role];
	const qContactId = qBinding?.contact_id ?? null;
	const qContact = contacts.find((c) => c.id === qContactId) ?? null;

	// Determine the effective display state
	const allFilled = group.properties.every((p) =>
		variableValues[p.displayName]?.trim(),
	);

	// When overridden, figure out what the override looks like
	// (could be a different contact or custom values)
	const overrideHasContact = isOverridden && variableValues[group.properties[0]?.displayName];

	return (
		<div
			className="p-3 w-full rounded-lg border border-base-300 bg-base-100"
			data-var-entry={group.properties[0]?.displayName}
		>
			{/* Role header */}
			<div className="flex items-center justify-between mb-1.5">
				<span className="label-text text-sm font-medium flex items-center gap-1.5">
					<StatusDot filled={allFilled} />
					{group.role}
				</span>
				<div className="join">
					<button
						type="button"
						className="join-item btn btn-ghost btn-xs px-1"
						onClick={() =>
							scrollToOccurrence(
								group.properties[0]?.displayName,
								"prev",
							)
						}
						title="Previous occurrence"
					>
						&lsaquo;
					</button>
					<button
						type="button"
						className="join-item btn btn-ghost btn-xs px-1"
						onClick={() =>
							scrollToOccurrence(
								group.properties[0]?.displayName,
								"next",
							)
						}
						title="Next occurrence"
					>
						&rsaquo;
					</button>
				</div>
			</div>

			{/* Override toggle */}
			<div className="flex items-center gap-2 mb-1.5">
				<button
					type="button"
					className={`flex items-center gap-1.5 text-xs transition-colors ${
						isOverridden
							? "text-warning hover:text-warning/80"
							: "text-base-content/50 hover:text-base-content/70"
					}`}
					onClick={() => onToggleOverride(!isOverridden)}
					title={
						isOverridden
							? "Click to re-link to questionnaire"
							: "Click to override for this document"
					}
				>
					{isOverridden ? (
						<LinkSlashIcon className="size-3.5" />
					) : (
						<LinkIcon className="size-3.5" />
					)}
					<span>
						{isOverridden
							? "Overridden for this document"
							: "Linked to questionnaire"}
					</span>
				</button>
			</div>

			{/* ── Linked state: greyed-out, shows questionnaire value ── */}
			{!isOverridden && (
				<>
					<select
						className="select select-bordered select-sm w-full opacity-50 pointer-events-none"
						value={qContact ? qContact.id : ""}
						disabled
						tabIndex={-1}
					>
						<option value="">Not assigned</option>
						{contacts.map((c) => (
							<option key={c.id} value={c.id}>
								{c.full_name}
								{c.relationship
									? ` (${c.relationship})`
									: ""}
							</option>
						))}
					</select>
					{qContact && (
						<div className="mt-2 pl-3 border-l-2 border-primary/30 opacity-75">
							<div className="space-y-1">
								{group.properties.map(
									({ displayName, property }) => {
										const value = getContactProperty(
											qContact,
											property,
										);
										return (
											<div
												key={displayName}
												className="flex items-center gap-2 text-xs"
											>
												<span className="text-base-content/50 min-w-20">
													{PROPERTY_LABELS[
														property
													] ?? property}
													:
												</span>
												<span
													className={
														value
															? "text-base-content"
															: "text-base-content/30 italic"
													}
												>
													{value || "empty"}
												</span>
											</div>
										);
									},
								)}
							</div>
						</div>
					)}
				</>
			)}

			{/* ── Overridden state: editable dropdown + manual fallback ── */}
			{isOverridden && (
				<>
					<select
						className="select select-bordered select-sm w-full select-warning"
						value={
							// Find if current values match any contact
							contacts.find((c) =>
								group.properties.every(
									(p) =>
										getContactProperty(c, p.property) ===
										(variableValues[p.displayName] ?? ""),
								),
							)?.id ?? "__manual__"
						}
						onChange={(e) => {
							const val = e.target.value;
							if (val === "__manual__") {
								onSelectContact(null);
							} else {
								onSelectContact(val);
							}
						}}
						onFocus={() =>
							onSelect(group.properties[0]?.displayName)
						}
						onBlur={onDeselect}
					>
						{contacts.map((c) => (
							<option key={c.id} value={c.id}>
								{c.full_name}
								{c.relationship
									? ` (${c.relationship})`
									: ""}
							</option>
						))}
						<option value="__manual__">Custom values...</option>
					</select>

					{/* Editable fields for the override */}
					<div className="mt-2 pl-3 border-l-2 border-warning/30 space-y-2">
						{group.properties.map(
							({ displayName, property }) => (
								<div key={displayName}>
									<label className="label pb-0.5">
										<span className="label-text text-xs text-base-content/60">
											{PROPERTY_LABELS[property] ??
												property}
										</span>
									</label>
									<input
										type="text"
										className="input input-bordered input-xs w-full"
										placeholder={`Enter ${PROPERTY_LABELS[property] ?? property}`}
										value={
											variableValues[displayName] ?? ""
										}
										onChange={(e) =>
											onManualChange(
												displayName,
												e.target.value,
											)
										}
										onFocus={() => onSelect(displayName)}
										onBlur={onDeselect}
									/>
								</div>
							),
						)}
					</div>
				</>
			)}
		</div>
	);
}
