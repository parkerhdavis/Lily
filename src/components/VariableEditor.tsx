import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";

/** Extract the display filename (without .docx extension) from a full path. */
function getDisplayName(docPath: string): string {
	const filename = docPath.split("/").pop() ?? docPath.split("\\").pop() ?? docPath;
	return filename.replace(/\.docx$/i, "");
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
	// Red = unfilled, yellow = selected, green = filled & not selected.
	const getLivePreviewHtml = useCallback(() => {
		let html = documentHtml;
		for (const [name, value] of Object.entries(variableValues)) {
			const pattern = `<span class="variable-highlight" data-variable="${name}">{${name}}</span>`;
			const isSelected = name === selectedVariable;

			if (isSelected) {
				// Selected variable is always yellow, showing value if filled
				const display = value || `{${name}}`;
				const replacement = `<span class="variable-highlight selected" data-variable="${name}">${display}</span>`;
				html = html.replaceAll(pattern, replacement);
			} else if (value) {
				// Filled and not selected — green
				const replacement = `<span class="variable-highlight filled" data-variable="${name}">${value}</span>`;
				html = html.replaceAll(pattern, replacement);
			}
			// Unfilled and not selected — leave as-is (base red styling)
		}
		return html;
	}, [documentHtml, variableValues, selectedVariable]);

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
							<span className="text-base-content/30 font-normal">.docx</span>
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
							{variables.map((variable) => {
							const isFilled = Boolean(variableValues[variable]);
							return (
								<label key={variable} className="form-control w-full">
									<div className="label">
										<span className="label-text text-sm font-medium flex items-center gap-1.5">
											<span
												className={`inline-block size-2 shrink-0 rounded-full ${isFilled ? "bg-success" : "bg-error"}`}
											/>
											{variable}
										</span>
									</div>
									<input
										type="text"
										className="input input-bordered input-sm w-full"
										placeholder={`Enter ${variable}`}
										value={variableValues[variable] ?? ""}
										onChange={(e) =>
											handleVariableChange(variable, e.target.value)
										}
										onFocus={() => setSelectedVariable(variable)}
										onBlur={() => setSelectedVariable(null)}
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
