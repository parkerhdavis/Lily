import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";

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
 * Regex that matches a variable-highlight span.
 * Captures: [1] = canonical key, [2] = original case, [3] = display text (e.g. {CLIENT NAME})
 */
const VARIABLE_SPAN_RE =
	/<span class="variable-highlight" data-variable="([^"]*)" data-original-case="([^"]*)">\{[^}]*\}<\/span>/g;

export default function VariableEditor() {
	const {
		variables,
		variableValues,
		documentHtml,
		documentPath,
		dirty,
		loading,
		error,
		updateVariable,
		renameDocument,
		saveDocument,
		setStep,
	} = useWorkflowStore();

	const [selectedVariable, setSelectedVariable] = useState<string | null>(
		null,
	);
	const [editingTitle, setEditingTitle] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement>(null);

	// Build a lookup from canonical (lowercase) key to display_name
	const canonicalToDisplay = useMemo(() => {
		const map: Record<string, string> = {};
		for (const v of variables) {
			map[v.display_name.toLowerCase()] = v.display_name;
		}
		return map;
	}, [variables]);

	// Focus the title input when entering edit mode
	useEffect(() => {
		if (editingTitle && titleInputRef.current) {
			titleInputRef.current.focus();
			titleInputRef.current.select();
		}
	}, [editingTitle]);

	// Ctrl+S / Cmd+S keyboard shortcut for saving
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				if (!loading) {
					saveDocument();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [loading, saveDocument]);

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

	// Build a live preview by replacing variable placeholders in the HTML.
	// Matches spans by canonical (lowercase) data-variable key, applies
	// casing from data-original-case.
	// Red = unfilled, yellow = selected, green = filled & not selected.
	const getLivePreviewHtml = useCallback(() => {
		return documentHtml.replace(
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
	}, [documentHtml, variableValues, selectedVariable, canonicalToDisplay]);

	const handleVariableChange = (name: string, value: string) => {
		updateVariable(name, value);
	};

	const filledCount = Object.values(variableValues).filter(
		(v) => v.length > 0,
	).length;

	return (
		<div className="flex flex-col h-screen">
			{/* Header */}
			<div className="flex items-center gap-4 p-4 border-b border-base-300 bg-base-200">
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={() => setStep("select-template")}
				>
					&larr; Back
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
				</div>
			</div>

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Main content: sidebar + preview */}
			<div className="flex flex-1 overflow-hidden">
				{/* Variable sidebar */}
				<div className="w-80 shrink-0 border-r border-base-300 overflow-y-auto p-4 bg-base-100">
					<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50 mb-4">
						Variables
					</h3>
					{variables.length === 0 ? (
						<p className="text-sm text-base-content/50">
							No variables found in this document.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							{variables.map((varInfo) => {
								const name = varInfo.display_name;
								const isFilled = Boolean(variableValues[name]);
								return (
									<label
										key={name}
										className="form-control w-full"
									>
										<div className="label">
											<span className="label-text text-sm font-medium flex items-center gap-1.5">
												<span
													className={`inline-block size-2 shrink-0 rounded-full ${isFilled ? "bg-success" : "bg-error"}`}
												/>
												{name}
											</span>
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
									</label>
								);
							})}
						</div>
					)}
				</div>

				{/* Document preview */}
				<div className="flex-1 overflow-y-auto p-8 bg-base-200">
					<div
						className="bg-white rounded-lg shadow-md p-8 max-w-4xl mx-auto prose prose-sm"
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
