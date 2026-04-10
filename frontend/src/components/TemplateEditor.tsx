import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import type {
	VariableInfo,
	VariableType,
	VariableSchema,
	VariableSchemaEntry,
	TextOccurrence,
	ConditionalDef,
} from "@/types";
import { extractFilename } from "@/utils/path";

/** Strip the .docx/.dotx extension for display. */
function stripDocx(name: string): string {
	return name.replace(/\.docx?$/i, "").replace(/\.dotx$/i, "");
}

/** Get the document position (paragraph index + char offset) from a mouse event. */
function getDocumentPosition(
	clientX: number,
	clientY: number,
	container: HTMLElement,
): { paraIdx: number; charOffset: number } | null {
	// Use caretPositionFromPoint (standard) or caretRangeFromPoint (WebKit)
	let textNode: Node | null = null;
	let offset = 0;

	// caretPositionFromPoint is the standard API; caretRangeFromPoint is WebKit
	const doc = document as Document & {
		caretPositionFromPoint?: (
			x: number,
			y: number,
		) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};

	if (doc.caretPositionFromPoint) {
		const pos = doc.caretPositionFromPoint(clientX, clientY);
		if (pos) {
			textNode = pos.offsetNode;
			offset = pos.offset;
		}
	} else if (doc.caretRangeFromPoint) {
		const range = doc.caretRangeFromPoint(clientX, clientY);
		if (range) {
			textNode = range.startContainer;
			offset = range.startOffset;
		}
	}

	if (!textNode || !container.contains(textNode)) return null;

	// Walk up to find the parent paragraph with data-para-idx
	let el: HTMLElement | null =
		textNode.nodeType === Node.ELEMENT_NODE
			? (textNode as HTMLElement)
			: textNode.parentElement;

	while (el && el !== container) {
		const paraIdx = el.getAttribute("data-para-idx");
		if (paraIdx !== null) {
			// Calculate char offset within this paragraph's text content
			const charOffset = getCharOffsetInParagraph(el, textNode, offset);
			return { paraIdx: Number.parseInt(paraIdx, 10), charOffset };
		}
		el = el.parentElement;
	}

	return null;
}

/** Calculate the character offset of a text node + offset within a paragraph element. */
function getCharOffsetInParagraph(
	paraEl: HTMLElement,
	targetNode: Node,
	targetOffset: number,
): number {
	const walker = document.createTreeWalker(
		paraEl,
		NodeFilter.SHOW_TEXT,
		null,
	);
	let charCount = 0;
	let node: Node | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: tree walker pattern
	while ((node = walker.nextNode())) {
		if (node === targetNode) {
			return charCount + targetOffset;
		}
		charCount += (node.textContent?.length ?? 0);
	}

	return charCount;
}

export default function TemplateEditor() {
	const {
		templateEditorPath,
		templateEditorHtml,
		templateEditorVars,
		templateEditorRelPath,
		templateEditorDirty,
		loading,
		error,
		insertTemplateVariable,
		removeTemplateVariable,
		findTextOccurrences,
		confirmTemplateEdits,
		discardTemplateEdits,
		moveTemplateSdt,
		insertSdtAtPosition,
		returnFromTemplateEditor,
	} = useWorkflowStore();

	// Sidebar resize state
	const [sidebarWidth, setSidebarWidth] = useState(480);
	const dragging = useRef(false);
	const dragStartX = useRef(0);
	const dragStartWidth = useRef(0);

	// Selection state
	const templatesDir = useSettingsStore((s) => s.settings.templates_dir);

	const [selectedText, setSelectedText] = useState<string | null>(null);
	const [variableName, setVariableName] = useState("");
	const [variableType, setVariableType] = useState<VariableType>("text");
	const [variableRequired, setVariableRequired] = useState(false);
	const [showAutocomplete, setShowAutocomplete] = useState(false);

	// Disambiguation state
	const disambigRef = useRef<HTMLDialogElement>(null);
	const [disambigOccurrences, setDisambigOccurrences] = useState<
		TextOccurrence[]
	>([]);
	const [disambigVarName, setDisambigVarName] = useState("");
	const [disambigSearchText, setDisambigSearchText] = useState("");

	// Conditional wrapping state
	const [showConditionalDialog, setShowConditionalDialog] = useState(false);
	const [condName, setCondName] = useState("");
	const [condControllingVar, setCondControllingVar] = useState("");
	const [condBranch, setCondBranch] = useState<"true" | "false">("true");
	const [condOtherBranchText, setCondOtherBranchText] = useState("");
	const condDialogRef = useRef<HTMLDialogElement>(null);

	// Removal state
	const [removingVar, setRemovingVar] = useState<string | null>(null);
	const [removalText, setRemovalText] = useState("");

	// Highlighted variable in preview
	const [highlightedVar, setHighlightedVar] = useState<string | null>(null);

	// Preview values state
	const [previewValues, setPreviewValues] = useState<
		Record<string, string>
	>({});

	// Confirmation dialog state
	const confirmDialogRef = useRef<HTMLDialogElement>(null);
	const discardDialogRef = useRef<HTMLDialogElement>(null);
	const unsavedDialogRef = useRef<HTMLDialogElement>(null);

	// Active tab for center pane
	const [activeTab, setActiveTab] = useState<"template" | "preview">(
		"template",
	);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		paraIdx: number;
		charOffset: number;
		onSdt: boolean;
		sdtVarName?: string;
	} | null>(null);
	const [contextVarName, setContextVarName] = useState("");

	// Load schema for conditional definitions used in preview
	const [templateSchema, setTemplateSchema] = useState<VariableSchema | null>(
		null,
	);
	useEffect(() => {
		if (!templatesDir || !templateEditorRelPath) return;
		invoke<VariableSchema>("load_template_schema", {
			templatesDir,
			templateRelPath: templateEditorRelPath,
		})
			.then(setTemplateSchema)
			.catch(() => {});
	}, [templatesDir, templateEditorRelPath, templateEditorVars]);

	const previewRef = useRef<HTMLDivElement>(null);
	const varNameInputRef = useRef<HTMLInputElement>(null);

	const templateName = templateEditorRelPath
		? stripDocx(extractFilename(templateEditorRelPath))
		: "Template";

	// Property labels for dot-notation resolution
	const PROP_LABELS: Record<string, string> = {
		full_name: "Full Name",
		first_name: "First Name",
		last_name: "Last Name",
		middle_name: "Middle Name",
		phone: "Phone",
		email: "Email",
		address: "Address",
		city: "City",
		state: "State",
		zip: "ZIP",
		relationship: "Relationship",
	};

	// Extract nested variable names from conditional templates in the schema.
	const allPreviewVars = useMemo(() => {
		const sdtVars = templateEditorVars.map((v) => ({
			name: v.display_name,
			isConditional: v.is_conditional,
		}));
		const sdtNames = new Set(sdtVars.map((v) => v.name));

		if (!templateSchema) return sdtVars;

		const nestedVars: { name: string; isConditional: boolean }[] = [];
		for (const entry of Object.values(templateSchema.variables)) {
			const condList =
				entry.conditions && entry.conditions.length > 0
					? entry.conditions
					: entry.condition
						? [entry.condition]
						: [];
			if (condList.length === 0) continue;
			for (const cond of condList) {
				for (const template of [
					cond.true_template,
					cond.false_template,
				]) {
					for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
						const inner = m[1].trim();
						const dotIdx = inner.lastIndexOf(".");
						let displayName = inner;
						if (dotIdx > 0) {
							const role = inner.substring(0, dotIdx).trim();
							const prop = inner
								.substring(dotIdx + 1)
								.trim()
								.toLowerCase();
							displayName = `${role} ${PROP_LABELS[prop] ?? prop}`;
						}
						if (
							!sdtNames.has(displayName) &&
							!nestedVars.some((v) => v.name === displayName)
						) {
							nestedVars.push({
								name: displayName,
								isConditional: false,
							});
						}
					}
				}
			}
		}

		return [...sdtVars, ...nestedVars];
	}, [templateEditorVars, templateSchema]);

	// Build live preview HTML
	const livePreviewHtml = useMemo(() => {
		if (!templateEditorHtml) return "";

		const canonicalToDisplay: Record<string, string> = {};
		for (const v of templateEditorVars) {
			canonicalToDisplay[v.display_name.toLowerCase()] = v.display_name;
		}

		const SDT_SPAN_RE =
			/<span class="variable-highlight filled" data-variable="([^"]*)" data-original-case="([^"]*)"(?: data-sdt-id="[^"]*")?>([^<]*)<\/span>/g;
		const BM_SPAN_RE =
			/<span class="variable-bookmark" data-variable="([^"]*)" data-original-case="([^"]*)"><\/span>/g;

		const condDefs: Record<string, ConditionalDef[]> = {};
		if (templateSchema) {
			for (const [name, entry] of Object.entries(
				templateSchema.variables,
			)) {
				if (entry.conditions && entry.conditions.length > 0) {
					condDefs[name] = entry.conditions;
				} else if (entry.condition) {
					condDefs[name] = [entry.condition];
				}
			}
		}
		const condOccurrenceCounts: Record<string, number> = {};

		let html = templateEditorHtml;

		html = html.replace(
			SDT_SPAN_RE,
			(
				_match,
				canonical: string,
				originalCase: string,
				_text: string,
			) => {
				const displayName = canonicalToDisplay[canonical];
				if (!displayName) return _match;

				const condDefList = condDefs[displayName];
				if (condDefList && condDefList.length > 0) {
					const idx = condOccurrenceCounts[displayName] ?? 0;
					condOccurrenceCounts[displayName] = idx + 1;
					const condDef = condDefList[idx] ?? condDefList[0];
					const controlValue =
						previewValues[condDef.controlling_variable] ?? "false";
					const isTrue = controlValue === "true";
					const branch = isTrue
						? condDef.true_template
						: condDef.false_template;
					if (!branch) return "";
					const resolved = branch.replace(
						/\{([^}]+)\}/g,
						(m, inner: string) => {
							const trimmed = inner.trim();
							const dotIdx = trimmed.lastIndexOf(".");
							let lookupName = trimmed;
							if (dotIdx > 0) {
								const role = trimmed
									.substring(0, dotIdx)
									.trim();
								const prop = trimmed
									.substring(dotIdx + 1)
									.trim()
									.toLowerCase();
								lookupName = `${role} ${PROP_LABELS[prop] ?? prop}`;
							}
							return previewValues[lookupName] ?? m;
						},
					);
					return `<span class="variable-highlight filled" data-variable="${canonical}" data-original-case="${originalCase}">${resolved}</span>`;
				}

				const value = previewValues[displayName];
				if (value) {
					return `<span class="variable-highlight filled" data-variable="${canonical}" data-original-case="${originalCase}">${value}</span>`;
				}
				return _match;
			},
		);

		html = html.replace(
			BM_SPAN_RE,
			(_match, canonical: string, originalCase: string) => {
				const displayName = canonicalToDisplay[canonical];
				if (!displayName) return _match;

				const condDefList = condDefs[displayName];
				if (condDefList && condDefList.length > 0) {
					const idx = condOccurrenceCounts[displayName] ?? 0;
					condOccurrenceCounts[displayName] = idx + 1;
					const condDef = condDefList[idx] ?? condDefList[0];
					const controlValue =
						previewValues[condDef.controlling_variable] ?? "false";
					const isTrue = controlValue === "true";
					const branch = isTrue
						? condDef.true_template
						: condDef.false_template;
					if (!branch) return _match;
					const resolved = branch.replace(
						/\{([^}]+)\}/g,
						(m, inner: string) => {
							const trimmed = inner.trim();
							const dotIdx = trimmed.lastIndexOf(".");
							let lookupName = trimmed;
							if (dotIdx > 0) {
								const role = trimmed
									.substring(0, dotIdx)
									.trim();
								const prop = trimmed
									.substring(dotIdx + 1)
									.trim()
									.toLowerCase();
								lookupName = `${role} ${PROP_LABELS[prop] ?? prop}`;
							}
							return previewValues[lookupName] ?? m;
						},
					);
					if (resolved) {
						return `<span class="variable-highlight filled" data-variable="${canonical}" data-original-case="${originalCase}">${resolved}</span>`;
					}
				}
				return _match;
			},
		);

		return html;
	}, [templateEditorHtml, previewValues, templateEditorVars, templateSchema]);

	// Sidebar resize drag handler
	const handleDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			dragging.current = true;
			dragStartX.current = e.clientX;
			dragStartWidth.current = sidebarWidth;

			const handleMove = (ev: MouseEvent) => {
				if (!dragging.current) return;
				const delta = ev.clientX - dragStartX.current;
				const newWidth = Math.max(
					360,
					Math.min(720, dragStartWidth.current + delta),
				);
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

	// Detect text selection in preview on mouseup
	useEffect(() => {
		const preview = previewRef.current;
		if (!preview) return;

		const handleMouseUp = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) return;

			const range = selection.getRangeAt(0);
			if (!preview.contains(range.commonAncestorContainer)) return;

			const text = selection.toString().trim();
			if (text.length > 0 && !text.includes("\n")) {
				setSelectedText(text);
				setVariableName("");
				setTimeout(() => varNameInputRef.current?.focus(), 50);
			}
		};

		preview.addEventListener("mouseup", handleMouseUp);
		return () => preview.removeEventListener("mouseup", handleMouseUp);
	}, []);

	// Make SDT badges draggable after HTML renders
	useEffect(() => {
		const preview = previewRef.current;
		if (!preview) return;

		const spans = preview.querySelectorAll(".variable-highlight");
		for (const span of spans) {
			(span as HTMLElement).draggable = true;
		}
	}, [templateEditorHtml]);

	// Drag-and-drop handlers for SDT badges
	useEffect(() => {
		const preview = previewRef.current;
		if (!preview) return;

		let draggedSdtId: string | null = null;

		const handleDragStartSdt = (e: DragEvent) => {
			const target = (e.target as HTMLElement).closest?.(
				".variable-highlight",
			) as HTMLElement | null;
			if (!target) return;

			const sdtId = target.getAttribute("data-sdt-id");
			if (!sdtId) {
				e.preventDefault();
				return;
			}

			draggedSdtId = sdtId;
			e.dataTransfer?.setData("text/plain", sdtId);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			target.classList.add("dragging");
		};

		const handleDragOver = (e: DragEvent) => {
			if (!draggedSdtId) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		};

		const handleDrop = (e: DragEvent) => {
			e.preventDefault();
			if (!draggedSdtId) return;

			const pos = getDocumentPosition(e.clientX, e.clientY, preview);
			if (pos) {
				moveTemplateSdt(draggedSdtId, pos.paraIdx, pos.charOffset);
			}

			// Clean up dragging class
			const draggingEl = preview.querySelector(".dragging");
			if (draggingEl) draggingEl.classList.remove("dragging");
			draggedSdtId = null;
		};

		const handleDragEnd = () => {
			const draggingEl = preview.querySelector(".dragging");
			if (draggingEl) draggingEl.classList.remove("dragging");
			draggedSdtId = null;
		};

		preview.addEventListener("dragstart", handleDragStartSdt);
		preview.addEventListener("dragover", handleDragOver);
		preview.addEventListener("drop", handleDrop);
		preview.addEventListener("dragend", handleDragEnd);

		return () => {
			preview.removeEventListener("dragstart", handleDragStartSdt);
			preview.removeEventListener("dragover", handleDragOver);
			preview.removeEventListener("drop", handleDrop);
			preview.removeEventListener("dragend", handleDragEnd);
		};
	}, [templateEditorHtml, moveTemplateSdt]);

	// Right-click context menu
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();

			const preview = previewRef.current;
			if (!preview) return;

			// Check if right-clicked on an existing SDT badge
			const target = (e.target as HTMLElement).closest?.(
				".variable-highlight",
			) as HTMLElement | null;
			if (target) {
				const varName =
					target.getAttribute("data-original-case") ?? undefined;
				setContextMenu({
					x: e.clientX,
					y: e.clientY,
					paraIdx: -1,
					charOffset: -1,
					onSdt: true,
					sdtVarName: varName,
				});
				return;
			}

			const pos = getDocumentPosition(e.clientX, e.clientY, preview);
			if (pos) {
				setContextMenu({
					x: e.clientX,
					y: e.clientY,
					paraIdx: pos.paraIdx,
					charOffset: pos.charOffset,
					onSdt: false,
				});
				setContextVarName("");
			}
		},
		[],
	);

	// Close context menu on click-outside or Escape
	useEffect(() => {
		if (!contextMenu) return;

		const handleClose = () => setContextMenu(null);
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setContextMenu(null);
		};

		document.addEventListener("click", handleClose);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("click", handleClose);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [contextMenu]);

	// Autocomplete filter
	const autocompleteOptions = useMemo(() => {
		if (!variableName.trim()) return [];
		const q = variableName.toLowerCase();
		return templateEditorVars
			.filter((v) => v.display_name.toLowerCase().includes(q))
			.map((v) => v.display_name)
			.slice(0, 8);
	}, [variableName, templateEditorVars]);

	// Count variable occurrences in preview HTML
	const varOccurrences = useCallback(
		(displayName: string): number => {
			if (!previewRef.current) return 0;
			const canonical = displayName.toLowerCase();
			return previewRef.current.querySelectorAll(
				`[data-variable="${CSS.escape(canonical)}"]`,
			).length;
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: re-count when HTML changes
		[templateEditorHtml],
	);

	// Scroll to a variable occurrence in preview
	const scrollToVariable = useCallback((displayName: string) => {
		if (!previewRef.current) return;
		const canonical = displayName.toLowerCase();
		const span = previewRef.current.querySelector(
			`[data-variable="${CSS.escape(canonical)}"]`,
		);
		if (span) {
			span.scrollIntoView({ behavior: "smooth", block: "center" });
			setHighlightedVar(displayName);
			setTimeout(() => setHighlightedVar(null), 2000);
		}
	}, []);

	// Save variable type to schema after inserting
	const saveToSchema = useCallback(
		async (name: string, varType: VariableType, required: boolean) => {
			if (!templatesDir || !templateEditorRelPath) return;
			try {
				const schema = await invoke<VariableSchema>(
					"load_template_schema",
					{
						templatesDir,
						templateRelPath: templateEditorRelPath,
					},
				);
				schema.variables[name] = {
					var_type: varType,
					required,
				};
				await invoke("save_template_schema", {
					templatesDir,
					templateRelPath: templateEditorRelPath,
					schema,
				});
			} catch {
				// Schema save is best-effort
			}
		},
		[templatesDir, templateEditorRelPath],
	);

	// Handle insert (single occurrence)
	const handleInsert = async () => {
		if (!selectedText || !variableName.trim()) return;

		try {
			await insertTemplateVariable(selectedText, variableName.trim());
			await saveToSchema(
				variableName.trim(),
				variableType,
				variableRequired,
			);
			setSelectedText(null);
			setVariableName("");
			setVariableType("text");
			setVariableRequired(false);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("occurrences")) {
				const occurrences = await findTextOccurrences(selectedText);
				setDisambigOccurrences(occurrences);
				setDisambigVarName(variableName.trim());
				setDisambigSearchText(selectedText);
				disambigRef.current?.showModal();
			}
		}
	};

	// Handle replace all
	const handleReplaceAll = async () => {
		if (!selectedText || !variableName.trim()) return;
		try {
			await insertTemplateVariable(
				selectedText,
				variableName.trim(),
				undefined,
				true,
			);
			await saveToSchema(
				variableName.trim(),
				variableType,
				variableRequired,
			);
			setSelectedText(null);
			setVariableName("");
			setVariableType("text");
			setVariableRequired(false);
		} catch (err) {
			useToastStore
				.getState()
				.addToast("error", `Replace all failed: ${err}`);
		}
	};

	// Handle disambiguation pick
	const handleDisambigPick = async (index: number) => {
		disambigRef.current?.close();
		await insertTemplateVariable(disambigSearchText, disambigVarName, index);
		setSelectedText(null);
		setVariableName("");
		setDisambigOccurrences([]);
	};

	// Handle "Make Conditional"
	const handleMakeConditional = async () => {
		if (!selectedText || !condName.trim()) return;
		const controlVar = condControllingVar.trim() || condName.trim();
		const trueTemplate =
			condBranch === "true" ? selectedText : condOtherBranchText;
		const falseTemplate =
			condBranch === "false" ? selectedText : condOtherBranchText;

		try {
			await insertTemplateVariable(selectedText, condName.trim());

			if (templatesDir && templateEditorRelPath) {
				const schema = await invoke<VariableSchema>(
					"load_template_schema",
					{
						templatesDir,
						templateRelPath: templateEditorRelPath,
					},
				);
				schema.variables[condName.trim()] = {
					var_type: "conditional",
					required: false,
					condition: {
						controlling_variable: controlVar,
						true_template: trueTemplate,
						false_template: falseTemplate,
					},
				};
				await invoke("save_template_schema", {
					templatesDir,
					templateRelPath: templateEditorRelPath,
					schema,
				});
			}

			setSelectedText(null);
			setCondName("");
			setCondControllingVar("");
			setCondBranch("true");
			setCondOtherBranchText("");
			setShowConditionalDialog(false);
			condDialogRef.current?.close();

			useToastStore
				.getState()
				.addToast(
					"success",
					`Conditional "${condName.trim()}" created`,
				);
		} catch (err) {
			useToastStore
				.getState()
				.addToast(
					"error",
					`Failed to create conditional: ${err}`,
				);
		}
	};

	// Handle variable removal
	const handleRemove = async () => {
		if (!removingVar) return;
		await removeTemplateVariable(removingVar, removalText);
		setRemovingVar(null);
		setRemovalText("");
	};

	// Handle context menu insert at position
	const handleContextInsert = async () => {
		if (!contextVarName.trim() || !contextMenu || contextMenu.onSdt) return;
		await insertSdtAtPosition(
			contextVarName.trim(),
			contextMenu.paraIdx,
			contextMenu.charOffset,
		);
		setContextMenu(null);
		setContextVarName("");
	};

	// Handle back navigation with dirty guard
	const handleBack = () => {
		if (templateEditorDirty) {
			unsavedDialogRef.current?.showModal();
		} else {
			returnFromTemplateEditor();
		}
	};

	// Loading state
	if (loading && !templateEditorHtml) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3">
				<span className="loading loading-spinner loading-lg" />
				<span className="text-base-content/50 text-sm">
					Loading template...
				</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<PageHeader
				title={templateName}
				subtitle={templateEditorRelPath ?? undefined}
				onBack={handleBack}
				backLabel="Pipeline"
			>
				<span className="badge badge-outline text-xs">
					{templateEditorVars.length} variable
					{templateEditorVars.length !== 1 ? "s" : ""}
				</span>
				{templateEditorDirty && (
					<>
						<span className="badge badge-warning badge-sm">
							Unsaved
						</span>
						<button
							type="button"
							className="btn btn-success btn-sm"
							onClick={() =>
								confirmDialogRef.current?.showModal()
							}
						>
							Save
						</button>
						<button
							type="button"
							className="btn btn-error btn-sm btn-outline"
							onClick={() =>
								discardDialogRef.current?.showModal()
							}
						>
							Discard
						</button>
					</>
				)}
			</PageHeader>

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Two-panel layout */}
			<div className="flex flex-1 min-h-0">
				{/* Sidebar */}
				<div
					className="shrink-0 overflow-y-auto border-r border-base-300 bg-base-100 relative"
					style={{ width: sidebarWidth }}
				>
					{/* Resize handle */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: drag handle */}
					<div
						className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/20 transition-colors z-10"
						onMouseDown={handleDragStart}
					/>

					<div className="p-4 space-y-4">
						{/* Insert Variable panel */}
						{selectedText && (
							<div className="p-3 rounded-lg border-2 border-primary/40 bg-primary/5 space-y-3">
								<div className="text-xs font-semibold text-primary uppercase tracking-wider">
									Insert Variable
								</div>
								<div>
									<div className="text-xs text-base-content/50 mb-1">
										Selected text:
									</div>
									<div className="badge badge-lg badge-outline font-mono text-xs max-w-full">
										<span className="truncate">
											{selectedText}
										</span>
									</div>
								</div>
								<div className="relative">
									<input
										ref={varNameInputRef}
										type="text"
										className="input input-bordered input-sm w-full"
										placeholder="Variable name..."
										value={variableName}
										onChange={(e) => {
											setVariableName(e.target.value);
											setShowAutocomplete(true);
										}}
										onFocus={() =>
											setShowAutocomplete(true)
										}
										onBlur={() =>
											setTimeout(
												() =>
													setShowAutocomplete(false),
												150,
											)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter")
												handleInsert();
											if (e.key === "Escape") {
												setSelectedText(null);
												setVariableName("");
											}
										}}
									/>
									{showAutocomplete &&
										autocompleteOptions.length > 0 && (
											<ul className="absolute z-20 top-full left-0 right-0 mt-1 menu bg-base-100 rounded-box shadow-lg border border-base-300 p-1 max-h-40 overflow-y-auto">
												{autocompleteOptions.map(
													(name) => (
														<li key={name}>
															<button
																type="button"
																className="text-sm"
																onMouseDown={(
																	e,
																) => {
																	e.preventDefault();
																	setVariableName(
																		name,
																	);
																	setShowAutocomplete(
																		false,
																	);
																}}
															>
																{name}
															</button>
														</li>
													),
												)}
											</ul>
										)}
								</div>
								<div className="flex gap-2">
									<select
										className="select select-bordered select-sm flex-1"
										value={variableType}
										onChange={(e) =>
											setVariableType(
												e.target
													.value as VariableType,
											)
										}
									>
										<option value="text">Text</option>
										<option value="date">Date</option>
										<option value="currency">
											Currency
										</option>
									</select>
									<label className="label cursor-pointer gap-1.5">
										<input
											type="checkbox"
											className="checkbox checkbox-xs"
											checked={variableRequired}
											onChange={(e) =>
												setVariableRequired(
													e.target.checked,
												)
											}
										/>
										<span className="label-text text-xs">
											Required
										</span>
									</label>
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-primary btn-sm flex-1"
										onClick={handleInsert}
										disabled={!variableName.trim()}
									>
										Insert
									</button>
									<button
										type="button"
										className="btn btn-outline btn-sm flex-1"
										onClick={handleReplaceAll}
										disabled={!variableName.trim()}
									>
										Replace All
									</button>
								</div>
								<div className="divider my-1 text-xs text-base-content/30">
									or
								</div>
								<button
									type="button"
									className="btn btn-secondary btn-sm btn-outline w-full"
									onClick={() => {
										setCondName("");
										setCondControllingVar("");
										setCondBranch("true");
										setCondOtherBranchText("");
										setShowConditionalDialog(true);
										setTimeout(
											() =>
												condDialogRef.current?.showModal(),
											0,
										);
									}}
								>
									Make Conditional
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs w-full"
									onClick={() => {
										setSelectedText(null);
										setVariableName("");
									}}
								>
									Cancel
								</button>
							</div>
						)}

						{/* Variable list */}
						<div>
							<SectionHeading className="mb-3">
								Variables
							</SectionHeading>
							{templateEditorVars.length === 0 ? (
								<p className="text-sm text-base-content/50">
									No variables in this template yet. Select
									text in the preview to insert a variable.
								</p>
							) : (
								<div className="flex flex-col gap-2">
									{templateEditorVars.map((v) => (
										<VariableCard
											key={v.display_name}
											variable={v}
											schemaEntry={
												templateSchema?.variables[
													v.display_name
												]
											}
											occurrenceCount={varOccurrences(
												v.display_name,
											)}
											isHighlighted={
												highlightedVar ===
												v.display_name
											}
											onScrollTo={() =>
												scrollToVariable(
													v.display_name,
												)
											}
											onRemove={() => {
												setRemovingVar(
													v.display_name,
												);
												setRemovalText("");
											}}
										/>
									))}
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Center: tabbed document view */}
				<div className="flex flex-col flex-1 min-w-0">
					{/* Tab bar */}
					<div className="flex border-b border-base-300 bg-base-100 shrink-0">
						<button
							type="button"
							className={`px-5 py-2 text-sm font-medium transition-colors border-b-2 ${
								activeTab === "template"
									? "border-primary text-primary"
									: "border-transparent text-base-content/50 hover:text-base-content/80"
							}`}
							onClick={() => setActiveTab("template")}
						>
							Template
						</button>
						<button
							type="button"
							className={`px-5 py-2 text-sm font-medium transition-colors border-b-2 ${
								activeTab === "preview"
									? "border-primary text-primary"
									: "border-transparent text-base-content/50 hover:text-base-content/80"
							}`}
							onClick={() => setActiveTab("preview")}
						>
							Preview
						</button>
					</div>

					{/* Tab content */}
					<div className="flex-1 overflow-y-auto p-6 bg-base-200">
						{activeTab === "template" ? (
							/* biome-ignore lint/a11y/useKeyWithClickEvents: context menu */
							<div
								ref={previewRef}
								className="bg-base-100 rounded-lg shadow-lg border border-base-300 p-8 prose prose-sm template-editor-preview"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: HTML preview from backend
								dangerouslySetInnerHTML={{
									__html: templateEditorHtml,
								}}
								onContextMenu={handleContextMenu}
							/>
						) : (
							<div
								className="bg-base-100 rounded-lg shadow-lg border border-base-300 p-8 prose prose-sm"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: HTML preview from backend
								dangerouslySetInnerHTML={{
									__html: livePreviewHtml,
								}}
							/>
						)}
					</div>
				</div>

				{/* Right sidebar: Preview Values */}
				<div className="w-96 shrink-0 overflow-y-auto border-l border-base-300 bg-base-100 p-4">
					<SectionHeading className="mb-3">
						Preview Values
					</SectionHeading>
					{allPreviewVars.length === 0 ? (
						<p className="text-xs text-base-content/40">
							No variables to preview yet.
						</p>
					) : (
						<div className="space-y-2">
							<p className="text-xs text-base-content/40 mb-2">
								Enter sample values to see how the document will
								look when filled.
							</p>
							{allPreviewVars.map((v) => (
								<div key={v.name}>
									{v.isConditional ? (
										<label className="flex items-center gap-2 cursor-pointer">
											<input
												type="checkbox"
												className="toggle toggle-sm toggle-primary"
												checked={
													previewValues[v.name] ===
													"true"
												}
												onChange={(e) =>
													setPreviewValues(
														(prev) => ({
															...prev,
															[v.name]: e.target
																.checked
																? "true"
																: "false",
														}),
													)
												}
											/>
											<span className="text-xs text-base-content/70">
												{v.name}
											</span>
										</label>
									) : (
										<div>
											<label className="text-xs text-base-content/50 block mb-0.5">
												{v.name}
											</label>
											<input
												type="text"
												className="input input-bordered input-xs w-full"
												placeholder={v.name}
												value={
													previewValues[v.name] ?? ""
												}
												onChange={(e) =>
													setPreviewValues(
														(prev) => ({
															...prev,
															[v.name]:
																e.target.value,
														}),
													)
												}
											/>
										</div>
									)}
								</div>
							))}
							{Object.values(previewValues).some((v) => v) && (
								<button
									type="button"
									className="btn btn-ghost btn-xs w-full mt-2"
									onClick={() => setPreviewValues({})}
								>
									Clear All
								</button>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Context menu */}
			{contextMenu && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: context menu overlay
				<div
					className="fixed inset-0 z-50"
					onClick={() => setContextMenu(null)}
				>
					<div
						className="absolute bg-base-100 rounded-lg shadow-xl border border-base-300 py-1 min-w-48"
						style={{
							left: contextMenu.x,
							top: contextMenu.y,
						}}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Escape") setContextMenu(null);
						}}
					>
						{contextMenu.onSdt ? (
							<button
								type="button"
								className="w-full text-left px-3 py-1.5 text-sm hover:bg-base-200 transition-colors"
								onClick={() => {
									if (contextMenu.sdtVarName) {
										setRemovingVar(contextMenu.sdtVarName);
										setRemovalText("");
									}
									setContextMenu(null);
								}}
							>
								Remove Variable
							</button>
						) : (
							<div className="px-3 py-2 space-y-2">
								<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider">
									Insert Variable
								</div>
								<input
									type="text"
									className="input input-bordered input-xs w-full"
									placeholder="Variable name..."
									value={contextVarName}
									onChange={(e) =>
										setContextVarName(e.target.value)
									}
									onKeyDown={(e) => {
										if (e.key === "Enter")
											handleContextInsert();
										if (e.key === "Escape")
											setContextMenu(null);
									}}
									// biome-ignore lint/a11y/noAutofocus: context menu auto-focus
									autoFocus
								/>
								<button
									type="button"
									className="btn btn-primary btn-xs w-full"
									disabled={!contextVarName.trim()}
									onClick={handleContextInsert}
								>
									Insert
								</button>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Disambiguation dialog */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close */}
			<dialog
				ref={disambigRef}
				className="modal"
				onClick={(e) => {
					if (e.target === disambigRef.current)
						disambigRef.current?.close();
				}}
			>
				<div className="modal-box max-w-lg">
					<h3 className="font-bold text-lg mb-2">
						Multiple Occurrences Found
					</h3>
					<p className="text-base-content/70 text-sm mb-4">
						&ldquo;{disambigSearchText}&rdquo; appears{" "}
						{disambigOccurrences.length} times. Choose which
						occurrence to replace:
					</p>
					<div className="space-y-2 max-h-60 overflow-y-auto">
						{disambigOccurrences.map((occ) => (
							<button
								key={occ.index}
								type="button"
								className="btn btn-ghost btn-sm w-full justify-start text-left h-auto py-2 font-normal"
								onClick={() => handleDisambigPick(occ.index)}
							>
								<span className="badge badge-sm badge-outline mr-2">
									&para;{occ.paragraph_number}
								</span>
								<span className="font-mono text-xs truncate">
									{occ.context}
								</span>
							</button>
						))}
					</div>
					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => disambigRef.current?.close()}
						>
							Cancel
						</button>
					</div>
				</div>
			</dialog>

			{/* Remove variable dialog */}
			{removingVar && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: inline dialog
				<dialog
					className="modal modal-open"
					onClick={(e) => {
						if (e.target === e.currentTarget)
							setRemovingVar(null);
					}}
				>
					<div className="modal-box">
						<h3 className="font-bold text-lg mb-2">
							Remove Variable
						</h3>
						<p className="text-base-content/70 text-sm mb-4">
							Replace variable{" "}
							<code className="bg-base-200 px-1 rounded">
								{removingVar}
							</code>{" "}
							with:
						</p>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							placeholder="Replacement text..."
							value={removalText}
							onChange={(e) => setRemovalText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleRemove();
							}}
							// biome-ignore lint/a11y/noAutofocus: dialog auto-focus
							autoFocus
						/>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => setRemovingVar(null)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error btn-sm"
								onClick={handleRemove}
							>
								Remove Variable
							</button>
						</div>
					</div>
				</dialog>
			)}

			{/* Conditional configuration dialog */}
			{showConditionalDialog && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close
				<dialog
					ref={condDialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === condDialogRef.current) {
							condDialogRef.current?.close();
							setShowConditionalDialog(false);
						}
					}}
				>
					<div className="modal-box max-w-lg">
						<h3 className="font-bold text-lg mb-1">
							Make Conditional
						</h3>
						<p className="text-sm text-base-content/60 mb-4">
							The selected text will be shown or hidden based on a
							controlling variable&apos;s value.
						</p>

						<div className="space-y-3">
							<div>
								<div className="text-xs text-base-content/50 mb-1">
									Selected text:
								</div>
								<div className="badge badge-lg badge-outline font-mono text-xs max-w-full">
									<span className="truncate">
										{selectedText}
									</span>
								</div>
							</div>

							<div>
								<label className="label pb-0.5">
									<span className="label-text text-xs">
										Conditional name
									</span>
								</label>
								<input
									type="text"
									className="input input-bordered input-sm w-full"
									placeholder='e.g., "Has Spouse"'
									value={condName}
									onChange={(e) =>
										setCondName(e.target.value)
									}
								/>
							</div>

							<div>
								<label className="label pb-0.5">
									<span className="label-text text-xs">
										Controlling variable (leave blank to use
										conditional name)
									</span>
								</label>
								<input
									type="text"
									className="input input-bordered input-sm w-full"
									placeholder={
										condName || "Same as conditional name"
									}
									value={condControllingVar}
									onChange={(e) =>
										setCondControllingVar(e.target.value)
									}
								/>
							</div>

							<div>
								<label className="label pb-0.5">
									<span className="label-text text-xs">
										This text is the...
									</span>
								</label>
								<div className="flex gap-2">
									<label className="label cursor-pointer gap-1.5">
										<input
											type="radio"
											className="radio radio-sm radio-primary"
											checked={condBranch === "true"}
											onChange={() =>
												setCondBranch("true")
											}
										/>
										<span className="label-text text-xs">
											True branch
										</span>
									</label>
									<label className="label cursor-pointer gap-1.5">
										<input
											type="radio"
											className="radio radio-sm radio-primary"
											checked={condBranch === "false"}
											onChange={() =>
												setCondBranch("false")
											}
										/>
										<span className="label-text text-xs">
											False branch
										</span>
									</label>
								</div>
							</div>

							<div>
								<label className="label pb-0.5">
									<span className="label-text text-xs">
										{condBranch === "true"
											? "Text when false (leave empty for nothing)"
											: "Text when true (leave empty for nothing)"}
									</span>
								</label>
								<textarea
									className="textarea textarea-bordered textarea-sm w-full"
									rows={2}
									placeholder="Other branch text..."
									value={condOtherBranchText}
									onChange={(e) =>
										setCondOtherBranchText(e.target.value)
									}
								/>
							</div>
						</div>

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									condDialogRef.current?.close();
									setShowConditionalDialog(false);
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={!condName.trim()}
								onClick={handleMakeConditional}
							>
								Create Conditional
							</button>
						</div>
					</div>
				</dialog>
			)}

			{/* Save confirmation dialog */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close */}
			<dialog
				ref={confirmDialogRef}
				className="modal"
				onClick={(e) => {
					if (e.target === confirmDialogRef.current)
						confirmDialogRef.current?.close();
				}}
			>
				<div className="modal-box">
					<h3 className="font-bold text-lg mb-2">Save Changes</h3>
					<p className="text-base-content/70 text-sm">
						Save all changes to the template? This will overwrite the
						original file.
					</p>
					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => confirmDialogRef.current?.close()}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-success btn-sm"
							onClick={async () => {
								confirmDialogRef.current?.close();
								await confirmTemplateEdits();
							}}
						>
							Save
						</button>
					</div>
				</div>
			</dialog>

			{/* Discard confirmation dialog */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close */}
			<dialog
				ref={discardDialogRef}
				className="modal"
				onClick={(e) => {
					if (e.target === discardDialogRef.current)
						discardDialogRef.current?.close();
				}}
			>
				<div className="modal-box">
					<h3 className="font-bold text-lg mb-2">Discard Changes</h3>
					<p className="text-base-content/70 text-sm">
						Discard all changes to the template? This cannot be
						undone.
					</p>
					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => discardDialogRef.current?.close()}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-error btn-sm"
							onClick={async () => {
								discardDialogRef.current?.close();
								await discardTemplateEdits();
							}}
						>
							Discard
						</button>
					</div>
				</div>
			</dialog>

			{/* Unsaved changes dialog (for back navigation) */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close */}
			<dialog
				ref={unsavedDialogRef}
				className="modal"
				onClick={(e) => {
					if (e.target === unsavedDialogRef.current)
						unsavedDialogRef.current?.close();
				}}
			>
				<div className="modal-box">
					<h3 className="font-bold text-lg mb-2">Unsaved Changes</h3>
					<p className="text-base-content/70 text-sm">
						You have unsaved changes to this template. What would you
						like to do?
					</p>
					<div className="modal-action gap-2">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() => unsavedDialogRef.current?.close()}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-error btn-sm btn-outline"
							onClick={async () => {
								unsavedDialogRef.current?.close();
								await discardTemplateEdits();
								returnFromTemplateEditor();
							}}
						>
							Discard
						</button>
						<button
							type="button"
							className="btn btn-success btn-sm"
							onClick={async () => {
								unsavedDialogRef.current?.close();
								await confirmTemplateEdits();
								returnFromTemplateEditor();
							}}
						>
							Save
						</button>
					</div>
				</div>
			</dialog>
		</div>
	);
}

// ─── Variable Card ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
	text: "Text",
	date: "Date",
	currency: "Currency",
	conditional: "Conditional",
};

function VariableCard({
	variable,
	schemaEntry,
	occurrenceCount,
	isHighlighted,
	onScrollTo,
	onRemove,
}: {
	variable: VariableInfo;
	schemaEntry?: VariableSchemaEntry;
	occurrenceCount: number;
	isHighlighted: boolean;
	onScrollTo: () => void;
	onRemove: () => void;
}) {
	return (
		<div
			className={`rounded-lg border bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] transition-all ${
				isHighlighted
					? "ring-2 ring-warning border-warning"
					: "border-base-300"
			}`}
		>
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					className="flex-1 text-left text-sm font-medium truncate hover:text-primary transition-colors"
					onClick={onScrollTo}
					title={`Scroll to {${variable.display_name}} in preview`}
				>
					{variable.display_name}
				</button>
				{schemaEntry?.var_type && schemaEntry.var_type !== "text" && (
					<span className="badge badge-xs badge-info">
						{TYPE_LABELS[schemaEntry.var_type] ??
							schemaEntry.var_type}
					</span>
				)}
				{variable.is_conditional && !schemaEntry?.var_type && (
					<span className="badge badge-xs badge-info">
						conditional
					</span>
				)}
				{schemaEntry?.required && (
					<span
						className="w-2 h-2 rounded-full bg-error shrink-0"
						title="Required"
					/>
				)}
				<span className="badge badge-sm badge-ghost">
					{occurrenceCount}
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs text-base-content/30 hover:text-error"
					onClick={onRemove}
					title="Remove this variable"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 16 16"
						fill="currentColor"
						className="size-3.5"
					>
						<title>Remove</title>
						<path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
					</svg>
				</button>
			</div>

			{/* Detail section */}
			{(variable.variants.length > 1 || schemaEntry) && (
				<div className="px-3 pb-3 space-y-2 border-t border-base-200 pt-2">
					{/* Case variants */}
					{variable.variants.length > 1 && (
						<div>
							<div className="text-xs text-base-content/40 mb-1">
								Case variants
							</div>
							<div className="flex flex-wrap gap-1">
								{variable.variants.map((v) => (
									<code
										key={v}
										className="text-xs bg-base-200 px-1.5 py-0.5 rounded"
									>
										{v}
									</code>
								))}
							</div>
						</div>
					)}

					{/* Schema info */}
					{schemaEntry && (
						<>
							{schemaEntry.var_type && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Type:
									</span>
									<span>
										{TYPE_LABELS[schemaEntry.var_type] ??
											schemaEntry.var_type}
									</span>
								</div>
							)}
							{schemaEntry.required && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Required:
									</span>
									<span className="text-error">Yes</span>
								</div>
							)}
							{schemaEntry.default && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Default:
									</span>
									<code className="bg-base-200 px-1 rounded">
										{schemaEntry.default}
									</code>
								</div>
							)}
							{schemaEntry.help && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Help:
									</span>
									<span className="text-base-content/60 italic">
										{schemaEntry.help}
									</span>
								</div>
							)}
							{schemaEntry.date_format && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Format:
									</span>
									<code className="bg-base-200 px-1 rounded">
										{schemaEntry.date_format}
									</code>
								</div>
							)}
							{schemaEntry.contact_role && (
								<div className="flex gap-2 text-xs">
									<span className="text-base-content/40">
										Contact:
									</span>
									<span>
										{schemaEntry.contact_role}
										{schemaEntry.contact_property &&
											` > ${schemaEntry.contact_property}`}
									</span>
								</div>
							)}
							{/* Conditional definitions */}
							{(schemaEntry.condition ||
								(schemaEntry.conditions &&
									schemaEntry.conditions.length > 0)) && (
								<ConditionalDetails
									condition={schemaEntry.condition}
									conditions={schemaEntry.conditions}
								/>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Conditional Details ────────────────────────────────────────────────────

function ConditionalDetails({
	condition,
	conditions,
}: {
	condition?: ConditionalDef;
	conditions?: ConditionalDef[];
}) {
	const defs =
		conditions && conditions.length > 0
			? conditions
			: condition
				? [condition]
				: [];
	if (defs.length === 0) return null;

	return (
		<div className="space-y-1.5">
			<div className="text-xs text-base-content/40">
				Conditional branches
			</div>
			{defs.map((def, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: stable order
					key={i}
					className="text-xs bg-base-200 rounded p-2 space-y-1"
				>
					<div>
						<span className="text-base-content/40">Controls: </span>
						<span className="font-medium">
							{def.controlling_variable}
						</span>
					</div>
					{def.true_template && (
						<div>
							<span className="text-success">True: </span>
							<span className="text-base-content/60">
								{def.true_template.length > 80
									? `${def.true_template.slice(0, 80)}...`
									: def.true_template}
							</span>
						</div>
					)}
					{def.false_template && (
						<div>
							<span className="text-error">False: </span>
							<span className="text-base-content/60">
								{def.false_template.length > 80
									? `${def.false_template.slice(0, 80)}...`
									: def.false_template}
							</span>
						</div>
					)}
				</div>
			))}
		</div>
	);
}
