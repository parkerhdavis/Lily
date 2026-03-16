import { useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TemplateTreeNode, SidecarFile } from "@/types";

// ─── Tree building ──────────────────────────────────────────────────────────

/** Build a navigable folder tree from flat relative paths. */
function buildTree(paths: string[]): TemplateTreeNode[] {
	const root: TemplateTreeNode[] = [];

	for (const relPath of paths) {
		const segments = relPath.split("/");
		let children = root;

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];
			const isFile = i === segments.length - 1;

			if (isFile) {
				children.push({ kind: "file", name, relPath });
			} else {
				let folder = children.find(
					(n): n is TemplateTreeNode & { kind: "folder" } =>
						n.kind === "folder" && n.name === name,
				);
				if (!folder) {
					folder = { kind: "folder", name, children: [] };
					children.push(folder);
				}
				children = folder.children;
			}
		}
	}

	// Sort: folders first (alphabetical), then files (alphabetical)
	sortTree(root);
	return root;
}

function sortTree(nodes: TemplateTreeNode[]) {
	nodes.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (const n of nodes) {
		if (n.kind === "folder") sortTree(n.children);
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check whether a template rel path has any existing documents in the sidecar. */
function hasExistingDocs(
	templateRelPath: string,
	sidecar: SidecarFile | null,
): boolean {
	if (!sidecar?.documents) return false;
	return Object.values(sidecar.documents).some(
		(meta) => meta.template_rel_path === templateRelPath,
	);
}

/** Collect existing documents for a template from the sidecar. */
function getExistingDocs(
	templateRelPath: string,
	sidecar: SidecarFile | null,
): { filename: string; modifiedAt: string }[] {
	if (!sidecar?.documents) return [];
	const docs: { filename: string; modifiedAt: string }[] = [];
	for (const [filename, meta] of Object.entries(sidecar.documents)) {
		if (meta.template_rel_path === templateRelPath) {
			docs.push({ filename, modifiedAt: meta.modified_at });
		}
	}
	docs.sort(
		(a, b) =>
			new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
	);
	return docs;
}

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

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function FolderIcon({ open: isOpen }: { open: boolean }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>{isOpen ? "Open folder" : "Closed folder"}</title>
			{isOpen ? (
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
				/>
			) : (
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
				/>
			)}
		</svg>
	);
}

function DocIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>Document</title>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function TemplateFolder({
	node,
	sidecar,
	onTemplateClick,
}: {
	node: TemplateTreeNode & { kind: "folder" };
	sidecar: SidecarFile | null;
	onTemplateClick: (relPath: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div>
			<button
				type="button"
				className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-medium gap-2"
				onClick={() => setExpanded(!expanded)}
			>
				<span className="text-xs opacity-40">{expanded ? "\u25BE" : "\u25B8"}</span>
				<FolderIcon open={expanded} />
				<span>{node.name}</span>
			</button>
			{expanded && (
				<div className="ml-4 border-l border-base-300 pl-1">
					{node.children.map((child) => (
						<TemplateTreeItem
							key={child.kind === "file" ? child.relPath : child.name}
							node={child}
							sidecar={sidecar}
							onTemplateClick={onTemplateClick}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TemplateFile({
	node,
	sidecar,
	onTemplateClick,
}: {
	node: TemplateTreeNode & { kind: "file" };
	sidecar: SidecarFile | null;
	onTemplateClick: (relPath: string) => void;
}) {
	const hasDocs = hasExistingDocs(node.relPath, sidecar);

	return (
		<button
			type="button"
			className={`btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal gap-2 ${
				hasDocs ? "text-success" : ""
			}`}
			onClick={() => onTemplateClick(node.relPath)}
		>
			<DocIcon />
			<span className="truncate">{stripDocx(node.name)}</span>
			{hasDocs && (
				<span className="badge badge-success badge-xs ml-auto shrink-0">
					in use
				</span>
			)}
		</button>
	);
}

function TemplateTreeItem({
	node,
	sidecar,
	onTemplateClick,
}: {
	node: TemplateTreeNode;
	sidecar: SidecarFile | null;
	onTemplateClick: (relPath: string) => void;
}) {
	if (node.kind === "folder") {
		return (
			<TemplateFolder
				node={node}
				sidecar={sidecar}
				onTemplateClick={onTemplateClick}
			/>
		);
	}
	return (
		<TemplateFile
			node={node}
			sidecar={sidecar}
			onTemplateClick={onTemplateClick}
		/>
	);
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function TemplatePicker() {
	const {
		templates,
		sidecar,
		loading,
		error,
		selectTemplate,
		openDocument,
		loadTemplates,
		setStep,
	} = useWorkflowStore();
	const { settings, save } = useSettingsStore();

	// Build tree from flat paths
	const tree = useMemo(() => buildTree(templates), [templates]);

	// Build client documents list from sidecar
	const clientDocs = useMemo(() => {
		if (!sidecar?.documents) return [];
		return Object.entries(sidecar.documents)
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
	}, [sidecar]);

	// Conflict dialog state
	const [conflictDocs, setConflictDocs] = useState<
		{ filename: string; modifiedAt: string }[]
	>([]);
	const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);

	const pickTemplatesDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Templates Folder",
			defaultPath: settings.templates_dir ?? undefined,
		});
		if (selected) {
			await save({ templates_dir: selected });
			loadTemplates(selected);
		}
	};

	const handleTemplateClick = (templateRelPath: string) => {
		const existing = getExistingDocs(templateRelPath, sidecar);

		if (existing.length > 0) {
			setConflictDocs(existing);
			setPendingTemplate(templateRelPath);
			dialogRef.current?.showModal();
		} else {
			selectTemplate(templateRelPath, settings.templates_dir!);
		}
	};

	const handleOpenExisting = (filename: string) => {
		dialogRef.current?.close();
		if (pendingTemplate) {
			openDocument(filename, pendingTemplate);
		}
		setConflictDocs([]);
		setPendingTemplate(null);
	};

	const handleCreateNew = () => {
		dialogRef.current?.close();
		if (pendingTemplate) {
			selectTemplate(pendingTemplate, settings.templates_dir!);
		}
		setConflictDocs([]);
		setPendingTemplate(null);
	};

	const handleCancelDialog = () => {
		dialogRef.current?.close();
		setConflictDocs([]);
		setPendingTemplate(null);
	};

	const handleClientDocClick = (
		filename: string,
		templateRelPath: string,
	) => {
		openDocument(filename, templateRelPath);
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	if (!settings.templates_dir) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
				<h2 className="text-2xl font-bold">Set Templates Folder</h2>
				<p className="text-base-content/70 text-center max-w-md">
					Before selecting a template, you need to choose the folder where
					your template documents are stored.
				</p>
				<button
					type="button"
					className="btn btn-primary"
					onClick={pickTemplatesDir}
				>
					Select Templates Folder
				</button>
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={() => setStep("select-directory")}
				>
					&larr; Back
				</button>
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
					onClick={() => setStep("select-directory")}
				>
					&larr; Back
				</button>
				<h2 className="text-xl font-bold">Select a Template</h2>
			</div>

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Two-panel layout */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left panel: Template Library */}
				<div className="flex-1 overflow-y-auto p-4 border-r border-base-300">
					<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50 mb-3">
						Template Library
					</h3>
					{tree.length === 0 ? (
						<p className="text-sm text-base-content/50">
							No .docx templates found in the configured folder.
						</p>
					) : (
						<div className="flex flex-col gap-0.5">
							{tree.map((node) => (
								<TemplateTreeItem
									key={node.kind === "file" ? node.relPath : node.name}
									node={node}
									sidecar={sidecar}
									onTemplateClick={handleTemplateClick}
								/>
							))}
						</div>
					)}
				</div>

				{/* Right panel: Client Documents */}
				<div className="w-80 shrink-0 overflow-y-auto p-4 bg-base-100">
					<h3 className="text-sm font-semibold uppercase tracking-wider text-base-content/50 mb-3">
						Client Documents
					</h3>
					{clientDocs.length === 0 ? (
						<p className="text-sm text-base-content/50">
							No documents in this folder yet. Select a template to
							create one.
						</p>
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
													.pop() ?? doc.templateRelPath,
											)}
											{" \u00B7 "}
											{formatDate(doc.modifiedAt)}
										</span>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Conflict dialog: existing document(s) found for this template */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close is a convenience, not primary interaction */}
			<dialog
				ref={dialogRef}
				className="modal"
				onClick={(e) => {
					if (e.target === dialogRef.current) handleCancelDialog();
				}}
			>
				<div className="modal-box">
					<h3 className="text-lg font-bold mb-2">
						Existing document found
					</h3>
					<p className="text-base-content/70 mb-4">
						This folder already has{" "}
						{conflictDocs.length === 1
							? "a document"
							: `${conflictDocs.length} documents`}{" "}
						created from this template. Would you like to open{" "}
						{conflictDocs.length === 1 ? "it" : "one"} or create a
						fresh copy?
					</p>

					<div className="flex flex-col gap-2 mb-4">
						{conflictDocs.map((doc) => (
							<button
								type="button"
								key={doc.filename}
								className="btn btn-outline btn-sm justify-between h-auto py-2"
								onClick={() => handleOpenExisting(doc.filename)}
							>
								<span className="font-medium truncate">
									{doc.filename}
								</span>
								<span className="text-xs text-base-content/50 shrink-0 ml-2">
									Modified {formatDate(doc.modifiedAt)}
								</span>
							</button>
						))}
					</div>

					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={handleCancelDialog}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={handleCreateNew}
						>
							Create New Copy
						</button>
					</div>
				</div>
			</dialog>
		</div>
	);
}
