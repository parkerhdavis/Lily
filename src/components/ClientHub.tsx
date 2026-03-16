import { useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** Format an ISO date string to a readable local format. */
function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

/** Strip the .docx extension from a filename for display. */
function stripDocx(name: string): string {
	return name.replace(/\.docx$/i, "");
}

/** Extract just the folder name from a full directory path. */
function getFolderName(dirPath: string): string {
	const segments = dirPath.replace(/\\/g, "/").split("/");
	return segments[segments.length - 1] || dirPath;
}

export default function ClientHub() {
	const {
		workingDir,
		lilyFile,
		loading,
		error,
		openDocument,
		startAddDocument,
		saveClientVariable,
		addClientVariable,
		removeClientVariable,
		loadTemplates,
		reset,
	} = useWorkflowStore();
	const { settings } = useSettingsStore();

	const [newVarName, setNewVarName] = useState("");
	const [addingVar, setAddingVar] = useState(false);
	const newVarInputRef = useRef<HTMLInputElement>(null);

	// Build client documents list from .lily file, sorted by modification date
	const clientDocs = useMemo(() => {
		if (!lilyFile?.documents) return [];
		return Object.entries(lilyFile.documents)
			.map(([filename, meta]) => ({
				filename,
				templateRelPath: meta.template_rel_path,
				modifiedAt: meta.modified_at,
			}))
			.sort(
				(a, b) =>
					new Date(b.modifiedAt).getTime() -
					new Date(a.modifiedAt).getTime(),
			);
	}, [lilyFile]);

	// Sort variables alphabetically for display
	const sortedVariables = useMemo(() => {
		if (!lilyFile?.variables) return [];
		return Object.entries(lilyFile.variables).sort(([a], [b]) =>
			a.localeCompare(b),
		);
	}, [lilyFile]);

	const handleVariableBlur = (name: string, value: string) => {
		// Auto-save on blur: persist to .lily file
		const currentValue = lilyFile?.variables[name] ?? "";
		if (value !== currentValue) {
			saveClientVariable(name, value);
		}
	};

	const handleAddVariable = async () => {
		const trimmed = newVarName.trim();
		if (!trimmed) return;

		try {
			await addClientVariable(trimmed);
			setNewVarName("");
			setAddingVar(false);
		} catch (err) {
			// Variable already exists or other error — keep the input open
			console.error("Failed to add variable:", err);
		}
	};

	const handleAddVarKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleAddVariable();
		} else if (e.key === "Escape") {
			setNewVarName("");
			setAddingVar(false);
		}
	};

	const handleStartAddVar = () => {
		setAddingVar(true);
		// Focus the input after it renders
		setTimeout(() => newVarInputRef.current?.focus(), 0);
	};

	const handleAddDocument = () => {
		// Load templates if needed, then navigate to template picker
		if (settings.templates_dir) {
			loadTemplates(settings.templates_dir);
		}
		startAddDocument();
	};

	const handleClientDocClick = (
		filename: string,
		templateRelPath: string,
	) => {
		openDocument(filename, templateRelPath);
	};

	const folderName = workingDir ? getFolderName(workingDir) : "Client";

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen">
			{/* Header */}
			<div className="flex items-center gap-4 p-4 border-b border-base-300 bg-base-200">
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={reset}
				>
					&larr; Back
				</button>
				<div className="flex-1 min-w-0">
					<h2 className="text-xl font-bold truncate">{folderName}</h2>
					{workingDir && (
						<p className="text-xs text-base-content/40 truncate">
							{workingDir}
						</p>
					)}
				</div>
			</div>

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Two-panel layout: variables + documents */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left panel: Client Variables */}
				<div className="flex-1 overflow-y-auto p-4 border-r border-base-300">
					<div className="flex items-center justify-between mb-4">
						<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Client Variables
						</h3>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={handleStartAddVar}
						>
							+ Add
						</button>
					</div>

					{sortedVariables.length === 0 && !addingVar ? (
						<div className="text-sm text-base-content/50 space-y-2">
							<p>No variables defined yet.</p>
							<p>
								Add a document to automatically populate
								variables, or add them manually.
							</p>
						</div>
					) : (
						<div className="flex flex-col gap-3">
							{sortedVariables.map(([name, value]) => (
								<VariableField
									key={name}
									name={name}
									value={value}
									onBlur={handleVariableBlur}
									onRemove={removeClientVariable}
								/>
							))}
						</div>
					)}

					{/* Add variable inline form */}
					{addingVar && (
						<div className="mt-3 flex gap-2">
							<input
								ref={newVarInputRef}
								type="text"
								className="input input-bordered input-sm flex-1"
								placeholder="Variable Name"
								value={newVarName}
								onChange={(e) => setNewVarName(e.target.value)}
								onKeyDown={handleAddVarKeyDown}
								onBlur={() => {
									if (!newVarName.trim()) {
										setAddingVar(false);
									}
								}}
							/>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={handleAddVariable}
								disabled={!newVarName.trim()}
							>
								Add
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									setNewVarName("");
									setAddingVar(false);
								}}
							>
								Cancel
							</button>
						</div>
					)}
				</div>

				{/* Right panel: Documents */}
				<div className="w-80 shrink-0 overflow-y-auto p-4 bg-base-100">
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Documents
						</h3>
						<button
							type="button"
							className="btn btn-primary btn-xs"
							onClick={handleAddDocument}
						>
							+ New
						</button>
					</div>

					{clientDocs.length === 0 ? (
						<div className="text-sm text-base-content/50 space-y-3">
							<p>No documents in this folder yet.</p>
							<button
								type="button"
								className="btn btn-primary btn-sm w-full"
								onClick={handleAddDocument}
							>
								Add New Document
							</button>
						</div>
					) : (
						<div className="flex flex-col gap-1">
							{clientDocs.map((doc) => (
								<button
									type="button"
									key={doc.filename}
									className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal"
									onClick={() =>
										handleClientDocClick(
											doc.filename,
											doc.templateRelPath,
										)
									}
								>
									<div className="flex flex-col items-start gap-0.5 min-w-0">
										<span className="font-medium truncate w-full">
											{stripDocx(doc.filename)}
										</span>
										<span className="text-xs text-base-content/40 truncate w-full">
											from{" "}
											{stripDocx(
												doc.templateRelPath
													.split("/")
													.pop() ??
													doc.templateRelPath,
											)}
											{" \u00B7 "}
											{formatDate(doc.modifiedAt)}
										</span>
									</div>
								</button>
							))}

							<div className="mt-2">
								<button
									type="button"
									className="btn btn-ghost btn-sm w-full text-base-content/50"
									onClick={handleAddDocument}
								>
									+ Add New Document
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function VariableField({
	name,
	value,
	onBlur,
	onRemove,
}: {
	name: string;
	value: string;
	onBlur: (name: string, value: string) => void;
	onRemove: (name: string) => void;
}) {
	const [localValue, setLocalValue] = useState(value);

	return (
		<label className="form-control w-full group">
			<div className="label">
				<span className="label-text text-sm font-medium flex items-center gap-1.5">
					<span
						className={`inline-block size-2 shrink-0 rounded-full ${localValue ? "bg-success" : "bg-base-300"}`}
					/>
					{name}
				</span>
				<button
					type="button"
					className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-50 hover:!opacity-100 text-error"
					onClick={() => onRemove(name)}
					title={`Remove ${name}`}
				>
					&times;
				</button>
			</div>
			<input
				type="text"
				className="input input-bordered input-sm w-full"
				placeholder={`Enter ${name}`}
				value={localValue}
				onChange={(e) => setLocalValue(e.target.value)}
				onBlur={() => onBlur(name, localValue)}
			/>
		</label>
	);
}
