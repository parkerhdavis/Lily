import { useCallback, useEffect, useRef } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";

export default function VariableEditor() {
	const {
		variables,
		variableValues,
		documentHtml,
		documentPath,
		loading,
		error,
		updateVariable,
		saveDocument,
		setStep,
	} = useWorkflowStore();

	const previewRef = useRef<HTMLDivElement>(null);
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

	// Build a live preview by replacing variables in the HTML
	const getLivePreviewHtml = useCallback(() => {
		let html = documentHtml;
		for (const [name, value] of Object.entries(variableValues)) {
			if (value) {
				const pattern = `<span class="variable-highlight">{${name}}</span>`;
				const replacement = `<span class="variable-highlight filled">${value}</span>`;
				html = html.replaceAll(pattern, replacement);
			}
		}
		return html;
	}, [documentHtml, variableValues]);

	// Debounced auto-save: save after 1.5s of inactivity
	const debouncedSave = useCallback(() => {
		if (saveTimeoutRef.current) {
			clearTimeout(saveTimeoutRef.current);
		}
		saveTimeoutRef.current = setTimeout(() => {
			saveDocument();
		}, 1500);
	}, [saveDocument]);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
		};
	}, []);

	const handleVariableChange = (name: string, value: string) => {
		updateVariable(name, value);
		debouncedSave();
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
				<div className="flex-1">
					<h2 className="text-lg font-semibold truncate">
						{documentPath?.split("/").pop() ??
							documentPath?.split("\\").pop()}
					</h2>
					<p className="text-xs text-base-content/50">
						{filledCount} of {variables.length} variables filled
					</p>
				</div>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={saveDocument}
					disabled={loading}
				>
					{loading ? (
						<span className="loading loading-spinner loading-xs" />
					) : (
						"Save Now"
					)}
				</button>
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
							{variables.map((variable) => (
								<label key={variable} className="form-control w-full">
									<div className="label">
										<span className="label-text text-sm font-medium">
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
									/>
								</label>
							))}
						</div>
					)}
				</div>

				{/* Document preview */}
				<div className="flex-1 overflow-y-auto p-8 bg-base-200">
					<div
						ref={previewRef}
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
