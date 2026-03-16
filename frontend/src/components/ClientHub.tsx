import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";

const QUESTIONNAIRE_FILENAME = "ClientQuestionnaire.docx";

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

/**
 * Fuzzy-filter a list of [name, value] variable entries by a search query.
 * The query is split into whitespace-separated tokens. A variable matches
 * if every token appears (case-insensitive) in either the variable name
 * or its current value.
 */
function fuzzyFilterEntries(
	entries: [string, string][],
	query: string,
): [string, string][] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return entries;

	const tokens = trimmed.split(/\s+/);
	return entries.filter(([name, value]) => {
		const lName = name.toLowerCase();
		const lValue = value.toLowerCase();
		return tokens.every((t) => lName.includes(t) || lValue.includes(t));
	});
}

interface ClientDoc {
	filename: string;
	templateRelPath: string;
	modifiedAt: string;
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
		deleteDocument,
		newVersionDocument,
		openTemplateFile,
		loadTemplates,
		reloadLilyFile,
		reset,
	} = useWorkflowStore();
	const { settings } = useSettingsStore();

	const [newVarName, setNewVarName] = useState("");
	const [addingVar, setAddingVar] = useState(false);
	const [varSearch, setVarSearch] = useState("");
	const newVarInputRef = useRef<HTMLInputElement>(null);

	// Build client documents list from .lily file, sorted by modification date
	const allDocs = useMemo(() => {
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

	// Separate the questionnaire from other documents
	const questionnaireDocs = useMemo(
		() =>
			allDocs.filter(
				(d) => d.templateRelPath === QUESTIONNAIRE_FILENAME,
			),
		[allDocs],
	);
	const otherDocs = useMemo(
		() =>
			allDocs.filter(
				(d) => d.templateRelPath !== QUESTIONNAIRE_FILENAME,
			),
		[allDocs],
	);

	// Build a set of conditional variable names from the .lily file
	const conditionalVarNames = useMemo(() => {
		return new Set(lilyFile?.conditional_variables ?? []);
	}, [lilyFile]);

	// Sort variables alphabetically for display
	const sortedVariables = useMemo(() => {
		if (!lilyFile?.variables) return [];
		return Object.entries(lilyFile.variables).sort(([a], [b]) =>
			a.localeCompare(b),
		);
	}, [lilyFile]);

	// Apply fuzzy search filter
	const filteredVariables = useMemo(
		() => fuzzyFilterEntries(sortedVariables, varSearch),
		[sortedVariables, varSearch],
	);

	const handleVariableBlur = (name: string, value: string) => {
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
		setTimeout(() => newVarInputRef.current?.focus(), 0);
	};

	const handleAddDocument = () => {
		if (settings.templates_dir) {
			loadTemplates(settings.templates_dir);
		}
		startAddDocument();
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

			{/* Two-panel layout: documents (main) + variables (sidebar) */}
			<div className="flex flex-1 overflow-hidden">
				{/* Main panel: Documents */}
				<div className="flex-1 overflow-y-auto p-4 border-r border-base-300">
					<div className="flex items-center justify-between mb-4">
						<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50">
							Documents
						</h3>
						<button
							type="button"
							className="btn btn-primary btn-xs"
							onClick={handleAddDocument}
						>
							+ New Document
						</button>
					</div>

					{allDocs.length === 0 ? (
						<div className="text-sm text-base-content/50 space-y-3">
							<p>No documents in this folder yet.</p>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={handleAddDocument}
							>
								Add New Document
							</button>
						</div>
					) : (
						<div className="flex flex-col gap-1">
							{/* Info Documents section (questionnaire) */}
							{questionnaireDocs.length > 0 && (
								<>
									<div className="divider my-2 text-xs text-base-content/30">
										Info Documents
									</div>
									{questionnaireDocs.map((doc) => (
										<DocumentRow
											key={doc.filename}
											doc={doc}
											onOpen={openDocument}
											onDelete={deleteDocument}
											onNewVersion={newVersionDocument}
											onOpenTemplate={openTemplateFile}
											onReload={reloadLilyFile}
										/>
									))}
								</>
							)}

							{/* Legal Documents section */}
							{otherDocs.length > 0 && (
								<div className="divider my-2 text-xs text-base-content/30">
									Legal Documents
								</div>
							)}

							{/* Other documents */}
							{otherDocs.map((doc) => (
								<DocumentRow
									key={doc.filename}
									doc={doc}
									onOpen={openDocument}
									onDelete={deleteDocument}
									onNewVersion={newVersionDocument}
									onOpenTemplate={openTemplateFile}
									onReload={reloadLilyFile}
								/>
							))}
						</div>
					)}
				</div>

				{/* Right sidebar: Client Variables */}
				<div className="w-80 shrink-0 overflow-y-auto p-4 bg-base-100">
					<div className="flex items-center justify-between mb-3">
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

					{sortedVariables.length > 0 && (
						<input
							type="text"
							className="input input-bordered input-sm w-full mb-3"
							placeholder="Search variables..."
							value={varSearch}
							onChange={(e) => setVarSearch(e.target.value)}
						/>
					)}

					{sortedVariables.length === 0 && !addingVar ? (
						<div className="text-sm text-base-content/50 space-y-2">
							<p>No variables defined yet.</p>
							<p>
								Add a document to automatically populate
								variables, or add them manually.
							</p>
						</div>
					) : filteredVariables.length === 0 && varSearch ? (
						<p className="text-sm text-base-content/50">
							No variables match your search.
						</p>
					) : (
						<div className="flex flex-col gap-3">
						{filteredVariables.map(([name, value]) => (
							<VariableField
								key={name}
								name={name}
								value={value}
								isConditional={conditionalVarNames.has(
									name,
								)}
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
			</div>
		</div>
	);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function DocumentRow({
	doc,
	onOpen,
	onDelete,
	onNewVersion,
	onOpenTemplate,
	onReload,
}: {
	doc: ClientDoc;
	onOpen: (filename: string, templateRelPath: string) => void;
	onDelete: (filename: string) => Promise<void>;
	onNewVersion: (filename: string) => Promise<void>;
	onOpenTemplate: (templateRelPath: string) => Promise<void>;
	onReload: () => Promise<void>;
}) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const deleteDialogRef = useRef<HTMLDialogElement>(null);

	// Close the context menu when clicking outside
	useEffect(() => {
		if (!menuPos) return;

		const handleClick = (e: MouseEvent) => {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target as Node)
			) {
				setMenuPos(null);
			}
		};
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuPos(null);
		};

		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [menuPos]);

	const handleContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		setMenuPos({ x: e.clientX, y: e.clientY });
	};

	const handleNewVersion = async () => {
		setMenuPos(null);
		await onNewVersion(doc.filename);
	};

	const handleDeleteClick = () => {
		setMenuPos(null);
		setConfirmingDelete(true);
		setTimeout(() => deleteDialogRef.current?.showModal(), 0);
	};

	const handleConfirmDelete = async () => {
		deleteDialogRef.current?.close();
		setConfirmingDelete(false);
		await onDelete(doc.filename);
	};

	const handleCancelDelete = () => {
		deleteDialogRef.current?.close();
		setConfirmingDelete(false);
	};

	const handleOpenTemplate = async () => {
		setMenuPos(null);
		await onOpenTemplate(doc.templateRelPath);
	};

	return (
		<>
			<button
				type="button"
				className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal"
				onClick={() => onOpen(doc.filename, doc.templateRelPath)}
				onContextMenu={handleContextMenu}
			>
				<div className="flex flex-col items-start gap-0.5 min-w-0">
					<span className="font-medium truncate w-full">
						{stripDocx(doc.filename)}
					</span>
					<span className="text-xs text-base-content/40 truncate w-full">
						from{" "}
						{stripDocx(
							doc.templateRelPath.split("/").pop() ??
								doc.templateRelPath,
						)}
						{" \u00B7 "}
						{formatDate(doc.modifiedAt)}
					</span>
				</div>
			</button>

			{/* Context menu */}
			{menuPos && (
				<div
					ref={menuRef}
					className="fixed z-50 menu bg-base-200 rounded-box shadow-lg border border-base-300 w-48 p-1"
					style={{ left: menuPos.x, top: menuPos.y }}
				>
					<li>
						<button
							type="button"
							className="text-sm"
							onClick={handleNewVersion}
						>
							New Version
						</button>
					</li>
					<li>
						<button
							type="button"
							className="text-sm text-error"
							onClick={handleDeleteClick}
						>
							Delete
						</button>
					</li>
					<div className="divider my-0" />
					<li>
						<button
							type="button"
							className="text-sm"
							onClick={handleOpenTemplate}
						>
							Open Template
						</button>
					</li>
				</div>
			)}

			{/* Delete confirmation dialog */}
			{confirmingDelete && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close is a convenience
				<dialog
					ref={deleteDialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === deleteDialogRef.current)
							handleCancelDelete();
					}}
				>
					<div className="modal-box">
						<h3 className="text-lg font-bold mb-2">
							Delete document?
						</h3>
						<p className="text-base-content/70 mb-4">
							Are you sure you want to delete{" "}
							<strong>{doc.filename}</strong>? This cannot be
							undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={handleCancelDelete}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error btn-sm"
								onClick={handleConfirmDelete}
							>
								Delete
							</button>
						</div>
					</div>
				</dialog>
			)}
		</>
	);
}

function VariableField({
	name,
	value,
	isConditional,
	onBlur,
	onRemove,
}: {
	name: string;
	value: string;
	isConditional: boolean;
	onBlur: (name: string, value: string) => void;
	onRemove: (name: string) => void;
}) {
	const [localValue, setLocalValue] = useState(value);

	if (isConditional) {
		const isChecked = localValue === "true";
		return (
			<label className="form-control w-full group">
				<div className="label cursor-pointer">
					<span className="label-text text-sm font-medium flex items-center gap-1.5">
						<input
							type="checkbox"
							className="checkbox checkbox-sm checkbox-primary"
							checked={isChecked}
							onChange={(e) => {
								const newVal = e.target.checked
									? "true"
									: "false";
								setLocalValue(newVal);
								onBlur(name, newVal);
							}}
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
			</label>
		);
	}

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
