import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import SectionHeading from "@/components/ui/SectionHeading";
import StatusDot from "@/components/ui/StatusDot";
import AppSwitcher from "@/components/ui/AppSwitcher";
import { extractFilename } from "@/utils/path";
import ContactRoleField from "./VariableEditor/ContactRoleField";
import UnsavedChangesDialog from "./VariableEditor/UnsavedChangesDialog";
import { renderLivePreview } from "./VariableEditor/previewRenderer";
import {
	fuzzyFilterVariables,
	getDisplayName,
	parseContactRoleVariant,
	getContactProperty,
	type ContactRoleGroup,
} from "./VariableEditor/variableHelpers";

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
		templateSchema,
		updateVariable,
		renameDocument,
		saveDocument,
		saveClientVariable,
		setContactBinding,
		clearContactBinding,
		setRoleOverride,
		returnToHub,
		openQuestionnaire,
	} = useWorkflowStore();
	const autosave = useSettingsStore((s) => s.settings.autosave) !== false;
	const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Autosave: debounce saves when autosave is enabled and document is dirty
	useEffect(() => {
		if (!autosave || !dirty) return;
		if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
		autosaveTimer.current = setTimeout(() => {
			saveDocument();
		}, 2000);
		return () => {
			if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
		};
	}, [autosave, dirty, variableValues, saveDocument]);

	// Current document filename (for looking up per-document overrides)
	const currentFilename = useMemo(() => {
		if (!documentPath) return null;
		return extractFilename(documentPath);
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
	const unsavedDialogRef = useRef<HTMLDialogElement>(null);
	const [sidebarWidth, setSidebarWidth] = useState(384);
	const dragging = useRef(false);
	const dragStartX = useRef(0);
	const dragStartWidth = useRef(0);
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

	// Sidebar resize drag handlers
	const handleDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			dragging.current = true;
			dragStartX.current = e.clientX;
			dragStartWidth.current = sidebarWidth;

			const handleMove = (ev: MouseEvent) => {
				if (!dragging.current) return;
				const delta = ev.clientX - dragStartX.current;
				const newWidth = Math.max(280, Math.min(600, dragStartWidth.current + delta));
				setSidebarWidth(newWidth);
			};
			const handleUp = () => {
				dragging.current = false;
				document.removeEventListener("mousemove", handleMove);
				document.removeEventListener("mouseup", handleUp);
			};
			document.addEventListener("mousemove", handleMove);
			document.addEventListener("mouseup", handleUp);
		},
		[sidebarWidth],
	);

	// Focus the title input when entering edit mode
	useEffect(() => {
		if (editingTitle && titleInputRef.current) {
			titleInputRef.current.focus();
			titleInputRef.current.select();
		}
	}, [editingTitle]);

	// Warn about unsaved changes when closing the window (when autosave is off)
	useEffect(() => {
		if (autosave || !dirty) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [autosave, dirty]);

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

	// Handle clicks on variable highlights in the document preview.
	// Clicking a variable span scrolls to and focuses its sidebar entry;
	// the onFocus handler on the input/button sets selectedVariable,
	// which triggers the yellow highlight in the preview.
	// Clicking on a non-variable area clears the selection.
	const handlePreviewClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement;
			const span = target.closest<HTMLElement>(
				"[data-variable]",
			);
			if (!span) {
				setSelectedVariable(null);
				return;
			}

			const canonical = span.dataset.variable;
			if (!canonical) return;

			const displayName = canonicalToDisplay[canonical];
			if (!displayName) return;

			// Scroll the sidebar entry into view
			const sidebarEl = sidebarRef.current?.querySelector(
				`[data-var-entry="${CSS.escape(displayName)}"]`,
			);
			if (sidebarEl) {
				sidebarEl.scrollIntoView({
					behavior: "smooth",
					block: "center",
				});
				// Focus the first interactive element in the entry.
				// Its onFocus handler will set selectedVariable and trigger the highlight.
				const focusable =
					sidebarEl.querySelector<HTMLElement>(
						"input[type=text]:not([disabled])",
					) ??
					sidebarEl.querySelector<HTMLElement>(
						"select:not([disabled])",
					);
				if (focusable) {
					setTimeout(() => focusable.focus(), 100);
				} else {
					// Conditional variables: focus the active True/False button
					const btns = sidebarEl.querySelectorAll<HTMLElement>(
						"button:not(.join-item):not([title])",
					);
					const btn = btns[0];
					if (btn) {
						setTimeout(() => btn.focus(), 100);
					} else {
						// No focusable element — set directly as fallback
						setSelectedVariable(displayName);
					}
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
	const livePreviewHtml = useMemo(
		() => renderLivePreview(documentHtml, variableValues, selectedVariable, canonicalToDisplay, conditionalDefs),
		[documentHtml, variableValues, selectedVariable, canonicalToDisplay, conditionalDefs],
	);

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

	// Detect variables that look like malformed conditionals (contain ?? or :: but
	// weren't parsed as conditional by the backend — likely syntax errors in template)
	const malformedConditionals = useMemo(() => {
		const set = new Set<string>();
		for (const v of variables) {
			if (
				!v.is_conditional &&
				(v.display_name.includes("??") || v.display_name.includes("::"))
			) {
				set.add(v.display_name);
			}
		}
		return set;
	}, [variables]);

	const filledCount = Object.entries(variableValues).filter(
		([name, v]) => conditionalVarNames.has(name) || v.length > 0,
	).length;

	if (loading && !documentHtml) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3">
				<span className="loading loading-spinner loading-lg" />
				<span className="text-base-content/50 text-sm">Loading document...</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<header className="flex items-center gap-4 px-5 py-3 border-b border-base-300 bg-base-100">
				<button
					type="button"
					className="btn btn-ghost btn-sm gap-1.5 text-base-content/70 hover:text-base-content"
					onClick={() => {
						if (dirty && !autosave) {
							unsavedDialogRef.current?.showModal();
						} else {
							returnToHub();
						}
					}}
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
					className="shrink-0 border-r border-base-300 overflow-y-auto p-4 bg-base-100 shadow-2xl relative"
					style={{ width: sidebarWidth }}
				>
					{/* Resize handle */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: drag handle */}
					<div
						className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
						onMouseDown={handleDragStart}
					/>
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
				<div className="flex flex-col gap-3">
					{(() => {
						const renderedRoles = new Set<string>();
						return filteredVariables.map((varInfo) => {
						const name = varInfo.display_name;

						// ── Conditional variable ──
						if (varInfo.is_conditional) {
							const isTrue =
								variableValues[name] === "true";
							const isFalse =
								variableValues[name] === "false";
							return (
								<div
									key={name}
									data-var-entry={name}
									className={`w-full rounded-lg border bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] ${selectedVariable === name ? "ring-2 ring-warning border-warning" : "border-base-300"}`}
								>
									{/* Name header */}
									<div className="flex items-center justify-between px-3 py-2 bg-base-200/60 border-b border-base-300 rounded-t-lg">
										<button
											type="button"
											className="text-sm font-bold hover:text-primary transition-colors cursor-pointer"
											onClick={() => openQuestionnaire()}
											title="Open in questionnaire"
										>
											{name}
										</button>
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
									{/* Value toggle */}
									<div className="p-3">
									<div className="flex rounded-lg overflow-hidden border border-base-300">
										<button
											type="button"
											className={`flex-1 text-xs font-semibold py-1.5 transition-colors ${
												isTrue
													? "bg-success text-success-content"
													: "bg-base-200 text-base-content/40 hover:bg-base-300"
											}`}
											onClick={() => {
												setSelectedVariable(name);
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
										>
											True
										</button>
										<button
											type="button"
											className={`flex-1 text-xs font-semibold py-1.5 transition-colors ${
												isFalse
													? "bg-error text-error-content"
													: "bg-base-200 text-base-content/40 hover:bg-base-300"
											}`}
											onClick={() => {
												setSelectedVariable(name);
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
										>
											False
										</button>
									</div>
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
									isSelected={group.properties.some(
										(p) => p.displayName === selectedVariable,
									)}
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
									onApplyToQuestionnaire={async () => {
										// Capture override values before any mutations
										const overrideValues: Record<string, string> = {};
										for (const p of group.properties) {
											overrideValues[p.displayName] = variableValues[p.displayName] ?? "";
										}
										// Set the contact binding first (triggers resolve_contact_variables,
										// which overwrites client vars with contact properties)
										const overrideData = roleOverrides[group.role];
										if (overrideData?.contact_id) {
											await setContactBinding(group.role, {
												contact_id: overrideData.contact_id,
												variable_mappings:
													lilyFile?.contact_bindings?.[group.role]?.variable_mappings ??
													Object.fromEntries(
														group.properties.map((p) => [p.displayName, p.property]),
													),
											});
										}
										// Now write override values — these win over resolved contact values
										for (const p of group.properties) {
											await saveClientVariable(p.displayName, overrideValues[p.displayName]);
										}
										// Remove the document override (re-link)
										await setRoleOverride(group.role, null);
										// Restore from the now-updated questionnaire values
										const { lilyFile: updatedLily } = useWorkflowStore.getState();
										const savedVars = updatedLily?.variables ?? {};
										for (const p of group.properties) {
											handleVariableChange(p.displayName, savedVars[p.displayName] ?? "");
										}
									}}
									onSelect={(varName) =>
										setSelectedVariable(varName)
									}
									scrollToOccurrence={scrollToOccurrence}
								/>
							);
						}

						// ── Regular replacement variable ──
						const isFilled = Boolean(variableValues[name]);
						const isMalformed = malformedConditionals.has(name);
						return (
							<div
								key={name}
								data-var-entry={name}
								className={`w-full rounded-lg border bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] ${selectedVariable === name ? "ring-2 ring-warning border-warning" : isMalformed ? "border-warning/50" : "border-base-300"}`}
							>
								{/* Name header */}
								<div className="flex items-center justify-between px-3 py-2 bg-base-200/60 border-b border-base-300 rounded-t-lg">
									<button
										type="button"
										className="text-sm font-bold flex items-center gap-1.5 hover:text-primary transition-colors cursor-pointer"
										onClick={() => openQuestionnaire()}
										title={isMalformed ? "Possible malformed conditional — check ?? and :: syntax in template" : "Open in questionnaire"}
									>
										<StatusDot filled={isFilled} />
										{name}
										{isMalformed && (
											<span className="badge badge-warning badge-xs ml-1" title="This variable contains ?? or :: but wasn't parsed as a conditional. Check the template syntax.">!</span>
										)}
									</button>
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
								{/* Value input — type-specific based on schema */}
								<div className="p-3">
									{(() => {
										const schemaEntry = templateSchema?.variables[name];
										const varType = schemaEntry?.var_type ?? "text";
										const val = variableValues[name] ?? "";

										if (varType === "date") {
											return (
												<div className="flex gap-2">
													<input
														type="date"
														className="input input-bordered input-sm flex-1"
														value={val}
														onChange={(e) =>
															handleVariableChange(name, e.target.value)
														}
														onFocus={() => setSelectedVariable(name)}
													/>
													{schemaEntry?.required && !val && (
														<span className="badge badge-error badge-sm self-center">required</span>
													)}
												</div>
											);
										}

										if (varType === "currency") {
											return (
												<div className="flex gap-2">
													<span className="flex items-center text-base-content/50 text-sm pl-1">$</span>
													<input
														type="text"
														inputMode="decimal"
														className="input input-bordered input-sm flex-1"
														placeholder="0.00"
														value={val}
														onChange={(e) => {
															const v = e.target.value.replace(/[^0-9.,]/g, "");
															handleVariableChange(name, v);
														}}
														onFocus={() => setSelectedVariable(name)}
													/>
													{schemaEntry?.required && !val && (
														<span className="badge badge-error badge-sm self-center">required</span>
													)}
												</div>
											);
										}

										// Default: text input
										return (
											<div className="flex gap-2">
												<input
													type="text"
													className="input input-bordered input-sm flex-1"
													placeholder={`Enter ${name}`}
													value={val}
													onChange={(e) =>
														handleVariableChange(name, e.target.value)
													}
													onFocus={() => setSelectedVariable(name)}
												/>
												{schemaEntry?.required && !val && (
													<span className="badge badge-error badge-sm self-center">required</span>
												)}
											</div>
										);
									})()}
									{templateSchema?.variables[name]?.help && (
										<p className="text-xs text-base-content/40 mt-1">
											{templateSchema.variables[name].help}
										</p>
									)}
								</div>
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
							__html: livePreviewHtml,
						}}
					/>
				</div>
			</div>

			<UnsavedChangesDialog
				dialogRef={unsavedDialogRef}
				onDiscard={() => {
					unsavedDialogRef.current?.close();
					returnToHub();
				}}
				onCancel={() => unsavedDialogRef.current?.close()}
				onSave={async () => {
					await saveDocument();
					unsavedDialogRef.current?.close();
					returnToHub();
				}}
			/>
		</div>
	);
}
