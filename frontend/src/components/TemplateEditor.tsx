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
import type {
	QuestionnaireDefFile,
	QuestionnaireIndex,
	QuestionnaireIndexEntry,
	QuestionDef,
	QuestionnaireSectionDef,
} from "@/types/questionnaire";
import { extractFilename } from "@/utils/path";

// ─── Questionnaire matching ─────────────────────────────────────────────────

/** Describes how a template variable maps to a questionnaire question. */
interface QuestionnaireMatch {
	/** What kind of questionnaire link this is. */
	kind: "text" | "conditional" | "contact-member" | "derived";
	/** The questionnaire section this question lives in. */
	section: QuestionnaireSectionDef;
	/** The question definition. */
	question: QuestionDef;
	/** For contact-member: the role name (e.g. "Healthcare POA Agent"). */
	role?: string;
	/** For contact-member: the contact property key (e.g. "full_name"). */
	property?: string;
	/** For contact-member: all mapped properties for the same role. */
	availableProperties?: { varName: string; property: string }[];
	/** For derived: the source variable names. */
	sources?: string[];
}

/** Build a map from variable display name → questionnaire match. */
function buildQuestionnaireMatchMap(
	questionnaire: QuestionnaireDefFile,
): Map<string, QuestionnaireMatch> {
	const map = new Map<string, QuestionnaireMatch>();

	for (const section of questionnaire.sections) {
		for (const q of section.questions) {
			if (q.kind === "text") {
				map.set(q.variable, { kind: "text", section, question: q });
			} else if (q.kind === "conditional") {
				map.set(q.variable, {
					kind: "conditional",
					section,
					question: q,
				});
			} else if (q.kind === "contact-role") {
				const availableProperties = Object.entries(
					q.variableMappings,
				).map(([varName, property]) => ({ varName, property }));

				for (const [varName, property] of Object.entries(
					q.variableMappings,
				)) {
					map.set(varName, {
						kind: "contact-member",
						section,
						question: q,
						role: q.role,
						property,
						availableProperties,
					});
				}

				// Also match the auto-generated "Has {role}" conditional
				const hasVar = `Has ${q.role}`;
				map.set(hasVar, {
					kind: "conditional",
					section,
					question: q,
				});
			} else if (q.kind === "derived") {
				map.set(q.variable, {
					kind: "derived",
					section,
					question: q,
					sources: q.sources,
				});
			}
		}
	}

	return map;
}

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
		renameTemplateVariable,
		returnFromTemplateEditor,
	} = useWorkflowStore();

	// Sidebar resize state
	const [sidebarWidth, setSidebarWidth] = useState(800);
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
	// Highlighted occurrence index (1-based working number)
	const [highlightedOccurrence, setHighlightedOccurrence] = useState<
		number | null
	>(null);

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

	// Load questionnaire index and selected questionnaire for variable contextualization
	const activeQuestionnaireId = useSettingsStore(
		(s) => s.settings.active_questionnaire_id,
	);
	const [questionnaireEntries, setQuestionnaireEntries] = useState<
		QuestionnaireIndexEntry[]
	>([]);
	const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState<
		string | null
	>(null);
	const [selectedQuestionnaire, setSelectedQuestionnaire] =
		useState<QuestionnaireDefFile | null>(null);

	// Load the questionnaire index on mount
	useEffect(() => {
		invoke<QuestionnaireIndex>("load_questionnaire_index")
			.then((index) => {
				setQuestionnaireEntries(index.questionnaires);
				// Default to app-wide active questionnaire, or first available
				const defaultId =
					index.active_questionnaire_id ??
					(index.questionnaires.length > 0
						? index.questionnaires[0].id
						: null);
				setSelectedQuestionnaireId(defaultId);
			})
			.catch(() => {});
	}, []);

	// Also respect the app-wide setting if it changes
	useEffect(() => {
		if (
			activeQuestionnaireId &&
			selectedQuestionnaireId === null &&
			questionnaireEntries.some((e) => e.id === activeQuestionnaireId)
		) {
			setSelectedQuestionnaireId(activeQuestionnaireId);
		}
	}, [activeQuestionnaireId, questionnaireEntries, selectedQuestionnaireId]);

	// Load the full questionnaire definition when selection changes
	useEffect(() => {
		if (!selectedQuestionnaireId) {
			setSelectedQuestionnaire(null);
			return;
		}
		invoke<QuestionnaireDefFile>("load_questionnaire", {
			id: selectedQuestionnaireId,
		})
			.then(setSelectedQuestionnaire)
			.catch(() => setSelectedQuestionnaire(null));
	}, [selectedQuestionnaireId]);

	// Build questionnaire → variable match map
	const questionnaireMatchMap = useMemo(() => {
		if (!selectedQuestionnaire)
			return new Map<string, QuestionnaireMatch>();
		return buildQuestionnaireMatchMap(selectedQuestionnaire);
	}, [selectedQuestionnaire]);

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
					400,
					Math.min(1100, dragStartWidth.current + delta),
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

	// Select a variable occurrence by its 1-based working number
	const selectOccurrence = useCallback((occurrenceIndex: number) => {
		setHighlightedOccurrence(occurrenceIndex);

		// Scroll the document preview to the nth variable-highlight span
		if (previewRef.current) {
			const spans = previewRef.current.querySelectorAll(
				".variable-highlight",
			);
			const span = spans[occurrenceIndex - 1]; // 0-based DOM index
			if (span) {
				span.scrollIntoView({ behavior: "smooth", block: "center" });
			}
		}
	}, []);

	// Detect text selection and variable clicks in preview
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

		const handleClick = (e: MouseEvent) => {
			const target = (e.target as HTMLElement).closest?.(
				".variable-highlight",
			) as HTMLElement | null;
			if (!target) return;

			// Find the working number by counting which nth .variable-highlight this is
			const allSpans = preview.querySelectorAll(".variable-highlight");
			for (let i = 0; i < allSpans.length; i++) {
				if (allSpans[i] === target || allSpans[i].contains(target)) {
					selectOccurrence(i + 1); // 1-based
					return;
				}
			}
		};

		preview.addEventListener("mouseup", handleMouseUp);
		preview.addEventListener("click", handleClick);
		return () => {
			preview.removeEventListener("mouseup", handleMouseUp);
			preview.removeEventListener("click", handleClick);
		};
	}, [templateEditorVars, selectOccurrence]);

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

	/** An individual variable occurrence in document order. */
	interface VarOccurrence {
		/** Working number (1-based). */
		index: number;
		/** Display name of the variable. */
		displayName: string;
		/** Canonical (lowercase) key. */
		canonical: string;
		/** SDT ID if available. */
		sdtId: string | null;
		/** Whether this is a conditional variable. */
		isConditional: boolean;
	}

	// Build ordered list of individual variable occurrences from the HTML
	const orderedOccurrences = useMemo((): VarOccurrence[] => {
		if (!templateEditorHtml) return [];

		const results: VarOccurrence[] = [];
		const re =
			/<span class="variable-highlight[^"]*" data-variable="([^"]*)" data-original-case="([^"]*)"(?: data-sdt-id="([^"]*)")?/g;

		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
		while ((match = re.exec(templateEditorHtml)) !== null) {
			const canonical = match[1];
			const originalCase = match[2];
			const sdtId = match[3] ?? null;
			const varInfo = templateEditorVars.find(
				(v) => v.display_name.toLowerCase() === canonical,
			);
			results.push({
				index: results.length + 1,
				displayName: varInfo?.display_name ?? originalCase,
				canonical,
				sdtId,
				isConditional: varInfo?.is_conditional ?? false,
			});
		}

		return results;
	}, [templateEditorHtml, templateEditorVars]);

	// Build HTML with working numbers injected into SDT badges
	const numberedTemplateHtml = useMemo(() => {
		if (!templateEditorHtml) return "";

		let idx = 0;
		return templateEditorHtml.replace(
			/(<span class="variable-highlight[^"]*" data-variable="[^"]*" data-original-case="[^"]*"(?:\s+data-sdt-id="[^"]*")?>)/g,
			(openTag) => {
				idx++;
				return `${openTag}<span class="sdt-working-number">#${idx}</span> `;
			},
		);
	}, [templateEditorHtml]);

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

						{/* Questionnaire context */}
						<div className="p-3 rounded-lg border border-base-300 bg-base-200/50 space-y-2">
							<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider">
								Questionnaire
							</div>
							{questionnaireEntries.length > 0 ? (
								<>
									<select
										className="select select-bordered select-sm w-full"
										value={
											selectedQuestionnaireId ?? ""
										}
										onChange={(e) =>
											setSelectedQuestionnaireId(
												e.target.value || null,
											)
										}
									>
										<option value="">
											None
										</option>
										{questionnaireEntries.map(
											(entry) => (
												<option
													key={entry.id}
													value={entry.id}
												>
													{entry.name}
												</option>
											),
										)}
									</select>
									{selectedQuestionnaire && (
										<div className="text-xs text-base-content/50">
											{(() => {
												const linked =
													orderedOccurrences.filter(
														(occ) =>
															questionnaireMatchMap.has(
																occ.displayName,
															),
													).length;
												const total =
													orderedOccurrences.length;
												return `${linked}/${total} variables linked`;
											})()}
										</div>
									)}
								</>
							) : (
								<p className="text-xs text-base-content/40 italic">
									No questionnaire libraries configured
								</p>
							)}
						</div>

						{/* Variable list */}
						<div>
							<SectionHeading className="mb-3">
								Variables
							</SectionHeading>
							{orderedOccurrences.length === 0 ? (
								<p className="text-sm text-base-content/50">
									No variables in this template yet. Select
									text in the preview to insert a variable.
								</p>
							) : (
								<div className="flex flex-col gap-2">
									{orderedOccurrences.map((occ) => {
										const varInfo =
											templateEditorVars.find(
												(v) =>
													v.display_name.toLowerCase() ===
													occ.canonical,
											);
										return (
											<VariableCard
												key={`${occ.index}-${occ.canonical}`}
												variable={
													varInfo ?? {
														display_name:
															occ.displayName,
														variants: [
															occ.displayName,
														],
														is_conditional:
															occ.isConditional,
													}
												}
												workingNumber={occ.index}
												schemaEntry={
													templateSchema
														?.variables[
														occ.displayName
													]
												}
												questionnaireMatch={questionnaireMatchMap.get(
													occ.displayName,
												)}
												isHighlighted={
													highlightedOccurrence ===
													occ.index
												}
												onScrollTo={() =>
													selectOccurrence(
														occ.index,
													)
												}
												onRemove={() => {
													setRemovingVar(
														occ.displayName,
													);
													setRemovalText("");
												}}
												schema={templateSchema}
												allVars={
													templateEditorVars
												}
												questionnaireMatchMap={
													questionnaireMatchMap
												}
												questionnaire={
													selectedQuestionnaire
												}
												onRename={
													renameTemplateVariable
												}
											/>
										);
									})}
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
									__html: numberedTemplateHtml,
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
				<div className="w-[32rem] shrink-0 overflow-y-auto border-l border-base-300 bg-base-100 p-4">
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

/** Human-readable property labels for contact fields. */
const PROPERTY_LABELS: Record<string, string> = {
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

function VariableCard({
	variable,
	workingNumber,
	schemaEntry,
	questionnaireMatch,
	isHighlighted,
	onScrollTo,
	onRemove,
	schema,
	allVars,
	questionnaireMatchMap,
	questionnaire,
	onRename,
}: {
	variable: VariableInfo;
	workingNumber: number;
	schemaEntry?: VariableSchemaEntry;
	questionnaireMatch?: QuestionnaireMatch;
	isHighlighted: boolean;
	onScrollTo: () => void;
	onRemove: () => void;
	schema?: VariableSchema | null;
	allVars?: VariableInfo[];
	questionnaireMatchMap?: Map<string, QuestionnaireMatch>;
	questionnaire?: QuestionnaireDefFile | null;
	onRename?: (oldName: string, newName: string) => Promise<void>;
}) {
	const isLinked = !!questionnaireMatch;
	const isContactMember = questionnaireMatch?.kind === "contact-member";
	const cardRef = useRef<HTMLDivElement>(null);
	const [showEditModal, setShowEditModal] = useState(false);

	// Scroll sidebar card into view when it becomes highlighted
	useEffect(() => {
		if (isHighlighted && cardRef.current) {
			cardRef.current.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
			});
		}
	}, [isHighlighted]);

	return (
		<div
			ref={cardRef}
			className={`rounded-lg border bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] transition-all ${
				isHighlighted
					? "ring-2 ring-warning border-warning"
					: "border-base-300"
			}`}
		>
			{/* Header row */}
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					className="flex-1 text-left text-sm font-medium truncate hover:text-primary transition-colors"
					onClick={onScrollTo}
					title={`Scroll to #${workingNumber} in preview`}
				>
					<span className="text-base-content/40 mr-1.5">
						#{workingNumber}
					</span>
					{variable.display_name}
				</button>
				{schemaEntry?.required && (
					<span
						className="w-2 h-2 rounded-full bg-error shrink-0"
						title="Required"
					/>
				)}
				<button
					type="button"
					className="btn btn-outline btn-xs gap-1"
					onClick={() => setShowEditModal(true)}
					title="Edit variable"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 16 16"
						fill="currentColor"
						className="size-3"
					>
						<path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z" />
						<path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z" />
					</svg>
					Edit
				</button>
			</div>

			{/* Detail section */}
			<div className="px-3 pb-3 space-y-2 border-t border-base-200 pt-2">
				{/* Source & type badges */}
				<div className="flex flex-wrap items-center gap-1.5">
					{isLinked ? (
						<span className="badge badge-xs badge-success badge-outline">
							Questionnaire
						</span>
					) : (
						<span className="badge badge-xs badge-ghost">
							Local
						</span>
					)}
					{(schemaEntry?.var_type ?? (variable.is_conditional ? "conditional" : null)) && (
						<span className="badge badge-xs badge-info badge-outline">
							{TYPE_LABELS[
								schemaEntry?.var_type ??
									(variable.is_conditional
										? "conditional"
										: "text")
							] ?? schemaEntry?.var_type}
						</span>
					)}
					{isContactMember && (
						<span className="badge badge-xs badge-secondary badge-outline">
							Contact
						</span>
					)}
					{questionnaireMatch?.kind === "derived" && (
						<span className="badge badge-xs badge-accent badge-outline">
							Derived
						</span>
					)}
				</div>

				{/* Questionnaire context: section name */}
				{isLinked && questionnaireMatch.section && (
					<div className="flex gap-2 text-xs">
						<span className="text-base-content/40">Section:</span>
						<span>{questionnaireMatch.section.title}</span>
					</div>
				)}

				{/* Derived variable sources */}
				{questionnaireMatch?.kind === "derived" &&
					questionnaireMatch.sources && (
						<div className="rounded border border-base-300 bg-base-200/50 p-2 space-y-1 text-xs">
							<div className="text-base-content/40">
								Derived from:
							</div>
							{questionnaireMatch.sources.map((src) => (
								<div key={src} className="pl-2 font-medium">
									{src}
								</div>
							))}
						</div>
					)}

				{/* Contact role hierarchy */}
				{isContactMember && questionnaireMatch.role && (
					<div className="rounded border border-base-300 bg-base-200/50 p-2 space-y-1.5">
						<div className="text-xs">
							<span className="text-base-content/40">
								Role:{" "}
							</span>
							<span className="font-medium">
								{questionnaireMatch.role}
							</span>
						</div>
						<div className="text-xs">
							<span className="text-base-content/40">
								Property:{" "}
							</span>
							<span className="font-medium">
								{PROPERTY_LABELS[
									questionnaireMatch.property ?? ""
								] ?? questionnaireMatch.property}
							</span>
						</div>
						{/* Other available properties from the same role */}
						{questionnaireMatch.availableProperties &&
							questionnaireMatch.availableProperties.length >
								1 && (
								<div className="text-xs pt-1 border-t border-base-300">
									<span className="text-base-content/40">
										Other members:{" "}
									</span>
									<span className="text-base-content/60">
										{questionnaireMatch.availableProperties
											.filter(
												(p) =>
													p.property !==
													questionnaireMatch.property,
											)
											.map(
												(p) =>
													PROPERTY_LABELS[
														p.property
													] ?? p.property,
											)
											.join(", ")}
									</span>
								</div>
							)}
					</div>
				)}

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

				{/* Additional schema info */}
				{schemaEntry && (
					<>
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
						{/* Conditional definitions */}
						{(schemaEntry.condition ||
							(schemaEntry.conditions &&
								schemaEntry.conditions.length > 0)) && (
							<ConditionalDetails
								condition={schemaEntry.condition}
								conditions={schemaEntry.conditions}
								schema={schema}
								allVars={allVars}
								questionnaireMatchMap={questionnaireMatchMap}
							/>
						)}
					</>
				)}
			</div>

			{/* Edit modal */}
			{showEditModal && (
				<VariableEditModal
					questionnaire={questionnaire}
					currentVarName={variable.display_name}
					onSelect={async (newName) => {
						setShowEditModal(false);
						if (newName !== variable.display_name && onRename) {
							await onRename(variable.display_name, newName);
						}
					}}
					onRemove={() => {
						setShowEditModal(false);
						onRemove();
					}}
					onClose={() => setShowEditModal(false)}
				/>
			)}
		</div>
	);
}

// ─── Conditional Details ────────────────────────────────────────────────────

/** Property labels for dot-notation resolution in nested variables. */
const NESTED_PROP_LABELS: Record<string, string> = {
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

/** Extract nested variable references from a conditional branch template string. */
function extractNestedVarNames(template: string): string[] {
	const names: string[] = [];
	for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
		const inner = m[1].trim();
		const dotIdx = inner.lastIndexOf(".");
		let displayName = inner;
		if (dotIdx > 0) {
			const role = inner.substring(0, dotIdx).trim();
			const prop = inner.substring(dotIdx + 1).trim().toLowerCase();
			displayName = `${role} ${NESTED_PROP_LABELS[prop] ?? prop}`;
		}
		if (!names.includes(displayName)) {
			names.push(displayName);
		}
	}
	return names;
}

function ConditionalDetails({
	condition,
	conditions,
	schema,
	allVars,
	questionnaireMatchMap,
}: {
	condition?: ConditionalDef;
	conditions?: ConditionalDef[];
	schema?: VariableSchema | null;
	allVars?: VariableInfo[];
	questionnaireMatchMap?: Map<string, QuestionnaireMatch>;
}) {
	const defs =
		conditions && conditions.length > 0
			? conditions
			: condition
				? [condition]
				: [];
	if (defs.length === 0) return null;

	// Collect all nested variable names across all branch templates
	const nestedNames = new Set<string>();
	for (const def of defs) {
		for (const name of extractNestedVarNames(def.true_template)) {
			nestedNames.add(name);
		}
		for (const name of extractNestedVarNames(def.false_template)) {
			nestedNames.add(name);
		}
	}

	return (
		<div className="space-y-2">
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
						<span className="text-base-content/40">
							Controls:{" "}
						</span>
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

			{/* Nested variable cards */}
			{nestedNames.size > 0 && (
				<div className="space-y-1.5 pt-1">
					<div className="text-xs text-base-content/40">
						Nested variables
					</div>
					{Array.from(nestedNames).map((name) => {
						const varInfo = allVars?.find(
							(v) => v.display_name === name,
						);
						const entry = schema?.variables[name];
						return (
							<NestedVariableCard
								key={name}
								name={name}
								varInfo={varInfo}
								schemaEntry={entry}
								questionnaireMatch={questionnaireMatchMap?.get(name)}
								schema={schema}
								allVars={allVars}
								questionnaireMatchMap={questionnaireMatchMap}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ─── Nested Variable Card ───────────────────────────────────────────────────

function NestedVariableCard({
	name,
	varInfo,
	schemaEntry,
	questionnaireMatch,
	schema,
	allVars,
	questionnaireMatchMap,
}: {
	name: string;
	varInfo?: VariableInfo;
	schemaEntry?: VariableSchemaEntry;
	questionnaireMatch?: QuestionnaireMatch;
	schema?: VariableSchema | null;
	allVars?: VariableInfo[];
	questionnaireMatchMap?: Map<string, QuestionnaireMatch>;
}) {
	const isLinked = !!questionnaireMatch;
	const isContactMember = questionnaireMatch?.kind === "contact-member";

	return (
		<div className="rounded border border-base-300 bg-base-100 text-xs">
			<div className="flex items-center gap-2 px-2.5 py-1.5">
				<span className="flex-1 font-medium truncate">{name}</span>
				{isLinked ? (
					<span className="badge badge-xs badge-success badge-outline">
						Q
					</span>
				) : (
					<span className="badge badge-xs badge-ghost">Local</span>
				)}
				{schemaEntry?.required && (
					<span
						className="w-1.5 h-1.5 rounded-full bg-error shrink-0"
						title="Required"
					/>
				)}
			</div>

			<div className="px-2.5 pb-2 space-y-1.5 border-t border-base-200 pt-1.5">
				{/* Contact role hierarchy */}
				{isContactMember && questionnaireMatch.role && (
					<div className="rounded border border-base-300 bg-base-200/50 p-1.5 space-y-1">
						<div>
							<span className="text-base-content/40">
								Role:{" "}
							</span>
							<span className="font-medium">
								{questionnaireMatch.role}
							</span>
						</div>
						<div>
							<span className="text-base-content/40">
								Property:{" "}
							</span>
							<span className="font-medium">
								{PROPERTY_LABELS[
									questionnaireMatch.property ?? ""
								] ?? questionnaireMatch.property}
							</span>
						</div>
					</div>
				)}

				{/* Case variants */}
				{varInfo && varInfo.variants.length > 1 && (
					<div>
						<div className="text-base-content/40 mb-0.5">
							Case variants
						</div>
						<div className="flex flex-wrap gap-1">
							{varInfo.variants.map((v) => (
								<code
									key={v}
									className="bg-base-200 px-1 py-0.5 rounded text-[10px]"
								>
									{v}
								</code>
							))}
						</div>
					</div>
				)}

				{schemaEntry && (
					<>
						{schemaEntry.default && (
							<div className="flex gap-2">
								<span className="text-base-content/40">
									Default:
								</span>
								<code className="bg-base-200 px-1 rounded">
									{schemaEntry.default}
								</code>
							</div>
						)}
						{schemaEntry.help && (
							<div className="flex gap-2">
								<span className="text-base-content/40">
									Help:
								</span>
								<span className="text-base-content/60 italic">
									{schemaEntry.help}
								</span>
							</div>
						)}
						{/* Recurse for nested conditionals */}
						{(schemaEntry.condition ||
							(schemaEntry.conditions &&
								schemaEntry.conditions.length > 0)) && (
							<ConditionalDetails
								condition={schemaEntry.condition}
								conditions={schemaEntry.conditions}
								schema={schema}
								allVars={allVars}
								questionnaireMatchMap={questionnaireMatchMap}
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
}

// ─── Variable Link Dropdown ─────────────────────────────────────────────────

function VariableEditModal({
	questionnaire,
	currentVarName,
	onSelect,
	onRemove,
	onClose,
}: {
	questionnaire?: QuestionnaireDefFile | null;
	currentVarName: string;
	onSelect: (newName: string) => void;
	onRemove?: () => void;
	onClose: () => void;
}) {
	const [expandedTabs, setExpandedTabs] = useState<Set<string>>(new Set());
	const [expandedSections, setExpandedSections] = useState<Set<string>>(
		new Set(),
	);
	const [expandedRoles, setExpandedRoles] = useState<Set<string>>(
		new Set(),
	);

	const toggle = (
		setter: React.Dispatch<React.SetStateAction<Set<string>>>,
		key: string,
	) => {
		setter((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// Chevron icon for tree nodes
	const Chevron = ({ expanded }: { expanded: boolean }) => (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 16 16"
			fill="currentColor"
			className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
		>
			<path
				fillRule="evenodd"
				d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z"
				clipRule="evenodd"
			/>
		</svg>
	);

	// Group sections by tab
	const tabs = questionnaire?.tabs ?? [];
	const sectionsByTab = useMemo(() => {
		const map = new Map<string, QuestionnaireSectionDef[]>();
		if (!questionnaire) return map;
		for (const section of questionnaire.sections) {
			const existing = map.get(section.tab) ?? [];
			existing.push(section);
			map.set(section.tab, existing);
		}
		return map;
	}, [questionnaire]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop
		<dialog
			className="modal modal-open"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="modal-box max-w-xl max-h-[80vh] flex flex-col">
				<h3 className="font-bold text-lg mb-1">Edit Variable</h3>
				<p className="text-sm text-base-content/60 mb-4">
					Currently:{" "}
					<code className="bg-base-200 px-1.5 py-0.5 rounded">
						{currentVarName}
					</code>
				</p>

				<div className="flex-1 overflow-y-auto space-y-1 -mx-2 px-2">
					{/* Questionnaire hierarchy */}
					{questionnaire && tabs.length > 0 && (
						<div>
							<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2">
								{questionnaire.name}
							</div>
							{tabs.map((tab) => {
								const sections = (
									sectionsByTab.get(tab.id) ?? []
								).filter(
									(s) =>
										s.questions.length > 0 ||
										s.kind === "contacts",
								);
								if (sections.length === 0) return null;
								const tabExpanded = expandedTabs.has(tab.id);
								return (
									<div key={tab.id} className="mb-1">
										{/* Tab level */}
										<button
											type="button"
											className="w-full text-left px-2 py-1.5 hover:bg-base-200 rounded flex items-center gap-2 font-medium text-sm"
											onClick={() =>
												toggle(
													setExpandedTabs,
													tab.id,
												)
											}
										>
											<Chevron
												expanded={tabExpanded}
											/>
											{tab.label}
										</button>
										{tabExpanded && (
											<div className="ml-3">
												{sections.map((section) => {
													const secExpanded =
														expandedSections.has(
															section.title,
														);
													return (
														<div
															key={
																section.title
															}
															className="mb-0.5"
														>
															{/* Section level */}
															<button
																type="button"
																className="w-full text-left px-2 py-1 hover:bg-base-200 rounded flex items-center gap-2 text-sm text-base-content/70"
																onClick={() =>
																	toggle(
																		setExpandedSections,
																		section.title,
																	)
																}
															>
																<Chevron
																	expanded={
																		secExpanded
																	}
																/>
																{
																	section.title
																}
															</button>
															{secExpanded && (
																<div className="ml-5">
																	{section.questions.map(
																		(
																			q,
																		) => {
																			if (
																				q.kind ===
																					"text" ||
																				q.kind ===
																					"conditional" ||
																				q.kind ===
																					"derived"
																			) {
																				const isCurrent =
																					q.variable ===
																					currentVarName;
																				return (
																					<button
																						key={
																							q.variable
																						}
																						type="button"
																						className={`w-full text-left px-2 py-1 hover:bg-base-200 rounded text-sm flex items-center gap-2 ${
																							isCurrent
																								? "text-primary font-medium bg-primary/5"
																								: ""
																						}`}
																						onClick={() =>
																							onSelect(
																								q.variable,
																							)
																						}
																					>
																						<span className="flex-1">
																							{
																								q.variable
																							}
																						</span>
																						{q.kind !==
																							"text" && (
																							<span className="badge badge-xs badge-info badge-outline">
																								{
																									q.kind
																								}
																							</span>
																						)}
																					</button>
																				);
																			}
																			if (
																				q.kind ===
																				"contact-role"
																			) {
																				const roleExpanded =
																					expandedRoles.has(
																						q.role,
																					);
																				return (
																					<div
																						key={
																							q.role
																						}
																					>
																						{/* Role level */}
																						<button
																							type="button"
																							className="w-full text-left px-2 py-1 hover:bg-base-200 rounded text-sm flex items-center gap-2"
																							onClick={() =>
																								toggle(
																									setExpandedRoles,
																									q.role,
																								)
																							}
																						>
																							<Chevron
																								expanded={
																									roleExpanded
																								}
																							/>
																							<span className="flex-1">
																								{
																									q.role
																								}
																							</span>
																							<span className="badge badge-xs badge-secondary badge-outline">
																								contact
																							</span>
																						</button>
																						{roleExpanded && (
																							<div className="ml-5">
																								{Object.entries(
																									q.variableMappings,
																								).map(
																									([
																										varName,
																										prop,
																									]) => {
																										const isCurrent =
																											varName ===
																											currentVarName;
																										return (
																											<button
																												key={
																													varName
																												}
																												type="button"
																												className={`w-full text-left px-2 py-1 hover:bg-base-200 rounded text-sm ${
																													isCurrent
																														? "text-primary font-medium bg-primary/5"
																														: ""
																												}`}
																												onClick={() =>
																													onSelect(
																														varName,
																													)
																												}
																											>
																												{PROPERTY_LABELS[
																													prop
																												] ??
																													prop}
																											</button>
																										);
																									},
																								)}
																							</div>
																						)}
																					</div>
																				);
																			}
																			return null;
																		},
																	)}
																</div>
															)}
														</div>
													);
												})}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}

					{/* Divider */}
					{questionnaire && (
						<div className="border-t border-base-300 my-3" />
					)}

					{/* Local variable */}
					<div>
						<div className="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2">
							Local Variable
						</div>
						<button
							type="button"
							className="w-full text-left px-2 py-1 hover:bg-base-200 rounded text-sm"
							onClick={() => onSelect(currentVarName)}
						>
							Keep as local ({currentVarName})
						</button>
					</div>

					{/* Remove */}
					{onRemove && (
						<>
							<div className="border-t border-base-300 my-3" />
							<button
								type="button"
								className="w-full text-left px-2 py-1.5 hover:bg-error/10 text-error/70 hover:text-error transition-colors rounded text-sm"
								onClick={onRemove}
							>
								Remove variable...
							</button>
						</>
					)}
				</div>

				<div className="modal-action">
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
					>
						Cancel
					</button>
				</div>
			</div>
		</dialog>
	);
}
