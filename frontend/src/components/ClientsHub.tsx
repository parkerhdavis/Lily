import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useToastStore } from "@/stores/toastStore";
import { useQuestionnaireStore } from "@/stores/questionnaireStore";
import { questionnaireDef as fallbackDef } from "@/data/questionnaireDef";
import type {
	ClientSummary,
	ClientTreeNode,
	DocumentStatus,
} from "@/types";
import type { QuestionnaireSectionDef } from "@/types/questionnaire";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLilyIcon } from "@/hooks/useLilyIcon";
import { extractFilename, extractFolderName } from "@/utils/path";

// ─── Status helpers ──────────────────────────────────────────────────────

const STATUS_LABELS: Record<DocumentStatus, string> = {
	not_started: "Not Started",
	drafting: "Drafting",
	reviewing: "Reviewing",
	complete: "Complete",
	executed: "Executed",
};

const STATUS_BADGES: Record<DocumentStatus, string> = {
	not_started: "badge-ghost",
	drafting: "badge-warning",
	reviewing: "badge-info",
	complete: "badge-success",
	executed: "badge-primary",
};

function stripDocx(name: string): string {
	return name.replace(/\.docx$/i, "");
}

function extractTemplateName(relPath: string): string {
	const parts = relPath.split("/");
	return stripDocx(parts[parts.length - 1] || relPath);
}

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

// ─── Tree helpers ────────────────────────────────────────────────────────

function extractClientsFromTree(nodes: ClientTreeNode[]): ClientSummary[] {
	const clients: ClientSummary[] = [];
	for (const node of nodes) {
		if (node.is_client && node.client_summary) {
			clients.push(node.client_summary);
		}
		clients.push(...extractClientsFromTree(node.children));
	}
	return clients;
}

// ─── Tab types ───────────────────────────────────────────────────────────

type ClientsTab = "clients" | "progress";

interface LibraryTree {
	dir: string;
	name: string;
	nodes: ClientTreeNode[];
}

interface ClientDoc {
	filename: string;
	templateRelPath: string;
	modifiedAt: string;
}

// ─── Main component ──────────────────────────────────────────────────────

export default function ClientsHub() {
	const { settings, save, addRecentDirectory } = useSettingsStore();
	const {
		workingDir,
		lilyFile,
		setWorkingDir,
		loadTemplates,
		goToHub,
		goToSettings,
		openDocument,
		openQuestionnaire,
		startAddDocument,
		deleteDocument,
		newVersionDocument,
		openTemplateFile,
		reloadLilyFile,
	} = useWorkflowStore();
	const { loadActiveQuestionnaire } = useQuestionnaireStore();
	const lilyIcon = useLilyIcon();

	const [activeTab, setActiveTab] = useState<ClientsTab>("clients");
	const [trees, setTrees] = useState<LibraryTree[]>([]);
	const [treeLoading, setTreeLoading] = useState(false);

	const libraryDirs = settings.client_library_dirs;

	// Load folder trees from library dirs
	const loadTrees = useCallback(async () => {
		if (!libraryDirs || libraryDirs.length === 0) {
			setTrees([]);
			return;
		}
		setTreeLoading(true);
		try {
			const results: LibraryTree[] = [];
			for (const dir of libraryDirs) {
				try {
					const nodes = await invoke<ClientTreeNode[]>(
						"list_library_tree",
						{ libraryDir: dir },
					);
					results.push({
						dir,
						name: extractFolderName(dir),
						nodes,
					});
				} catch (err) {
					console.error(
						`Failed to load tree for ${dir}:`,
						err,
					);
				}
			}
			setTrees(results);
		} finally {
			setTreeLoading(false);
		}
	}, [libraryDirs]);

	useEffect(() => {
		loadTrees();
	}, [loadTrees]);

	// Derive flat client list from trees for the progress tab
	const clients = useMemo(() => {
		const all = trees.flatMap((t) => extractClientsFromTree(t.nodes));
		all.sort((a, b) => a.client_name.localeCompare(b.client_name));
		return all;
	}, [trees]);

	const selectClient = async (dir: string) => {
		await addRecentDirectory(dir);
		save({ last_working_dir: dir });
		if (settings.templates_dir) {
			await loadTemplates(settings.templates_dir);
		}
		setWorkingDir(dir);
	};

	const pickClientFolder = async () => {
		const selected = await open({
			directory: true,
			title: "Open Client Folder",
			defaultPath: settings.last_working_dir ?? undefined,
		});
		if (selected) {
			await selectClient(selected);
		}
	};

	// Aggregate stats for progress tab
	const stats = useMemo(() => {
		const allReqs = clients.flatMap((c) => c.required_documents);
		const total = allReqs.length;
		const byStatus: Record<string, number> = {};
		for (const req of allReqs) {
			byStatus[req.status] = (byStatus[req.status] || 0) + 1;
		}
		return { totalClients: clients.length, totalDocs: total, byStatus };
	}, [clients]);

	return (
		<div className="flex flex-col h-full">
			<PageHeader title="Clients" onBack={goToHub}>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={pickClientFolder}
				>
					Open Client Folder
				</button>
			</PageHeader>

			{/* Tab bar */}
			<div className="border-b border-base-300">
				<div className="flex">
					{(
						[
							{ id: "clients", label: "Clients" },
							{ id: "progress", label: "Progress" },
						] as const
					).map((tab) => (
						<button
							key={tab.id}
							type="button"
							className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
								activeTab === tab.id
									? "border-primary text-primary"
									: "border-transparent text-base-content/50 hover:text-base-content/80 hover:bg-base-200/50"
							}`}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>
			</div>

			{/* Tab content */}
			<div className="flex-1 overflow-hidden">
				{activeTab === "clients" && (
					<ClientsTreeTab
						trees={trees}
						loading={treeLoading}
						hasLibraryDirs={libraryDirs.length > 0}
						workingDir={workingDir}
						lilyFile={lilyFile}
						onSelectClient={selectClient}
						onGoToSettings={goToSettings}
						lilyIcon={lilyIcon}
						settings={settings}
						onOpenQuestionnaire={openQuestionnaire}
						onStartAddDocument={startAddDocument}
						onOpenDocument={openDocument}
						onDeleteDocument={deleteDocument}
						onNewVersionDocument={newVersionDocument}
						onOpenTemplateFile={openTemplateFile}
						onReloadLilyFile={reloadLilyFile}
						onLoadTemplates={loadTemplates}
						loadActiveQuestionnaire={loadActiveQuestionnaire}
					/>
				)}
				{activeTab === "progress" && (
					<ProgressTab
						clients={clients}
						stats={stats}
						hasLibraryDirs={libraryDirs.length > 0}
						onGoToSettings={goToSettings}
						lilyIcon={lilyIcon}
					/>
				)}
			</div>
		</div>
	);
}

// ─── Clients Tree Tab ───────────────────────────────────────────────────

function ClientsTreeTab({
	trees,
	loading,
	hasLibraryDirs,
	workingDir,
	lilyFile,
	onSelectClient,
	onGoToSettings,
	lilyIcon,
	settings,
	onOpenQuestionnaire,
	onStartAddDocument,
	onOpenDocument,
	onDeleteDocument,
	onNewVersionDocument,
	onOpenTemplateFile,
	onReloadLilyFile,
	onLoadTemplates,
	loadActiveQuestionnaire,
}: {
	trees: LibraryTree[];
	loading: boolean;
	hasLibraryDirs: boolean;
	workingDir: string | null;
	lilyFile: import("@/types").LilyFile | null;
	onSelectClient: (dir: string) => void;
	onGoToSettings: () => void;
	lilyIcon: string;
	settings: import("@/types").AppSettings;
	onOpenQuestionnaire: () => void;
	onStartAddDocument: () => void;
	onOpenDocument: (filename: string, templateRelPath: string) => void;
	onDeleteDocument: (filename: string) => Promise<void>;
	onNewVersionDocument: (filename: string) => Promise<void>;
	onOpenTemplateFile: (templateRelPath: string) => Promise<void>;
	onReloadLilyFile: () => Promise<void>;
	onLoadTemplates: (templatesDir: string) => Promise<void>;
	loadActiveQuestionnaire: () => Promise<import("@/types/questionnaire").QuestionnaireDefFile | null>;
}) {
	if (!hasLibraryDirs) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 p-8">
				<img src={lilyIcon} alt="" className="size-16 opacity-20" />
				<p className="text-base-content/50 text-center max-w-sm">
					Configure a client library folder in Settings to browse
					and manage your clients.
				</p>
				<p className="text-xs text-base-content/30 text-center max-w-sm">
					A client library is a folder containing client subfolders,
					each with a .lily project file.
				</p>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={onGoToSettings}
				>
					Open Settings
				</button>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="loading loading-spinner loading-md" />
			</div>
		);
	}

	return (
		<div className="flex h-full">
			{/* Left sidebar: folder tree */}
			<div className="w-72 shrink-0 border-r border-base-300 overflow-y-auto p-4">
				{trees.map((lib, i) => (
					<div key={lib.dir}>
						{i > 0 && (
							<div className="border-b border-base-300 mb-4" />
						)}
						<SectionHeading className="mb-3">
							{lib.name}
						</SectionHeading>
						{lib.nodes.length === 0 ? (
							<p className="text-sm text-base-content/50 px-3">
								No folders found.
							</p>
						) : (
							<div className="flex flex-col gap-0.5">
								{lib.nodes.map((node) => (
									<ClientTreeItem
										key={node.path}
										node={node}
										selectedDir={workingDir}
										onSelectDir={onSelectClient}
									/>
								))}
							</div>
						)}
					</div>
				))}
			</div>

			{/* Right pane: client content */}
			{workingDir && lilyFile ? (
				<ClientContentPane
					workingDir={workingDir}
					lilyFile={lilyFile}
					lilyIcon={lilyIcon}
					settings={settings}
					onOpenQuestionnaire={onOpenQuestionnaire}
					onStartAddDocument={onStartAddDocument}
					onOpenDocument={onOpenDocument}
					onDeleteDocument={onDeleteDocument}
					onNewVersionDocument={onNewVersionDocument}
					onOpenTemplateFile={onOpenTemplateFile}
					onReloadLilyFile={onReloadLilyFile}
					onLoadTemplates={onLoadTemplates}
					loadActiveQuestionnaire={loadActiveQuestionnaire}
				/>
			) : (
				<div className="flex-1 flex items-center justify-center text-base-content/40 text-sm">
					Select a client to view details
				</div>
			)}
		</div>
	);
}

// ─── Client Content Pane (merged from ClientHub) ────────────────────────

function ClientContentPane({
	workingDir,
	lilyFile,
	lilyIcon,
	settings,
	onOpenQuestionnaire,
	onStartAddDocument,
	onOpenDocument,
	onDeleteDocument,
	onNewVersionDocument,
	onOpenTemplateFile,
	onReloadLilyFile,
	onLoadTemplates,
	loadActiveQuestionnaire,
}: {
	workingDir: string;
	lilyFile: import("@/types").LilyFile;
	lilyIcon: string;
	settings: import("@/types").AppSettings;
	onOpenQuestionnaire: () => void;
	onStartAddDocument: () => void;
	onOpenDocument: (filename: string, templateRelPath: string) => void;
	onDeleteDocument: (filename: string) => Promise<void>;
	onNewVersionDocument: (filename: string) => Promise<void>;
	onOpenTemplateFile: (templateRelPath: string) => Promise<void>;
	onReloadLilyFile: () => Promise<void>;
	onLoadTemplates: (templatesDir: string) => Promise<void>;
	loadActiveQuestionnaire: () => Promise<import("@/types/questionnaire").QuestionnaireDefFile | null>;
}) {
	const [docSearch, setDocSearch] = useState("");

	// Dynamic questionnaire definition for stats
	const [qDef, setQDef] = useState<QuestionnaireSectionDef[]>(fallbackDef);
	useEffect(() => {
		(async () => {
			try {
				let def = null;
				if (lilyFile.questionnaire_id) {
					try {
						def = await invoke<
							import("@/types/questionnaire").QuestionnaireDefFile
						>("load_questionnaire", {
							id: lilyFile.questionnaire_id,
						});
					} catch {
						// Fall through
					}
				}
				if (!def) {
					def = await loadActiveQuestionnaire();
				}
				if (def) {
					setQDef(def.sections);
				}
			} catch {
				// Use fallback
			}
		})();
	}, [lilyFile.questionnaire_id, loadActiveQuestionnaire]);

	const allDocs = useMemo(() => {
		if (!lilyFile.documents) return [];
		return Object.entries(lilyFile.documents)
			.map(([filename, meta]) => ({
				filename,
				templateRelPath: meta.template_rel_path,
				modifiedAt: meta.modified_at,
			}))
			.sort((a, b) => a.filename.localeCompare(b.filename));
	}, [lilyFile]);

	const questionnaireStats = useMemo(() => {
		const vars = lilyFile.variables ?? {};
		const contactCount = lilyFile.contacts?.length ?? 0;
		let total = 0;
		let filled = 0;
		for (const section of qDef) {
			if (section.kind === "contacts") {
				total++;
				if (contactCount > 0) filled++;
				continue;
			}
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (vars[q.variable]?.trim()) filled++;
				}
			}
		}
		return { total, filled };
	}, [lilyFile, qDef]);

	const handleAddDocument = () => {
		if (settings.templates_dir) {
			onLoadTemplates(settings.templates_dir);
		}
		onStartAddDocument();
	};

	const handleExport = async () => {
		const folderName = extractFolderName(workingDir);
		const path = await saveDialog({
			title: "Export Client Data",
			defaultPath: `${folderName} - Export.json`,
			filters: [{ name: "JSON", extensions: ["json"] }],
		});
		if (path) {
			try {
				await invoke("export_client_data", {
					workingDir,
					exportPath: path,
				});
				useToastStore
					.getState()
					.addToast("success", "Client data exported");
			} catch (err) {
				useToastStore
					.getState()
					.addToast("error", `Export failed: ${err}`);
			}
		}
	};

	const handleImport = async () => {
		const path = await open({
			title: "Import Client Data",
			filters: [
				{ name: "JSON / Lily", extensions: ["json", "lily"] },
			],
		});
		if (path) {
			try {
				const updated = await invoke<import("@/types").LilyFile>(
					"import_client_data",
					{ workingDir, importPath: path },
				);
				useWorkflowStore.setState({ lilyFile: updated });
				useToastStore
					.getState()
					.addToast("success", "Client data imported");
			} catch (err) {
				useToastStore
					.getState()
					.addToast("error", `Import failed: ${err}`);
			}
		}
	};

	const handleOpenFolder = async () => {
		try {
			await invoke("open_file_in_os", { filePath: workingDir });
		} catch (err) {
			console.error("Failed to open folder:", err);
		}
	};

	const folderName = extractFolderName(workingDir);
	const contactCount = lilyFile.contacts?.length ?? 0;
	const docCount = allDocs.length;

	return (
		<div className="flex-1 flex flex-col min-w-0">
			{/* Pinned header */}
			<div className="shrink-0 border-b border-base-300 px-6 py-4">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<h2 className="text-xl font-semibold truncate">
							{folderName}
						</h2>
						<p className="text-xs text-base-content/40 font-mono truncate mt-0.5">
							{workingDir}
						</p>
						<p className="text-sm text-base-content/50 mt-1">
							{docCount} document{docCount !== 1 ? "s" : ""}
							{contactCount > 0 &&
								` \u00B7 ${contactCount} contact${contactCount !== 1 ? "s" : ""}`}
						</p>
					</div>
					<div className="flex gap-2 shrink-0">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={handleOpenFolder}
							title="Open in file manager"
						>
							Open Folder
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={handleAddDocument}
						>
							+ Add Document
						</button>
						<div className="dropdown dropdown-end">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								tabIndex={0}
							>
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="size-4">
									<title>More</title>
									<path d="M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 12.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
								</svg>
							</button>
							{/* biome-ignore lint/a11y/noNoninteractiveTabindex: daisyUI dropdown pattern */}
							<ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box shadow-lg border border-base-300 w-44 p-1 z-50">
								<li>
									<button type="button" onClick={handleExport}>
										Export Client Data
									</button>
								</li>
								<li>
									<button type="button" onClick={handleImport}>
										Import Client Data
									</button>
								</li>
							</ul>
						</div>
					</div>
				</div>
			</div>

			{/* Scrollable content */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-3xl space-y-6">
					{/* Questionnaire card */}
					<button
						type="button"
						className="w-full text-left p-5 rounded-xl border-2 border-primary/40 bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] hover:shadow-[0_8px_28px_rgba(0,0,0,0.35)] transition-shadow"
						onClick={onOpenQuestionnaire}
					>
						<div className="flex items-center gap-4">
							<img
								src={lilyIcon}
								alt=""
								className="size-9 opacity-60"
							/>
							<div className="flex-1 min-w-0">
								<div className="font-semibold text-base">
									Client Questionnaire
								</div>
								<div className="text-sm text-base-content/50 mt-0.5">
									{questionnaireStats.total > 0
										? `${questionnaireStats.filled} of ${questionnaireStats.total} fields filled`
										: "Fill out client information"}
									{contactCount > 0 &&
										` \u00B7 ${contactCount} contact${contactCount !== 1 ? "s" : ""}`}
								</div>
							</div>
							{questionnaireStats.total > 0 && (
								<div
									className="radial-progress text-primary text-sm"
									style={
										{
											"--value": Math.round(
												(questionnaireStats.filled /
													questionnaireStats.total) *
													100,
											),
											"--size": "3rem",
											"--thickness": "3px",
										} as React.CSSProperties
									}
									role="progressbar"
								>
									{questionnaireStats.filled}/
									{questionnaireStats.total}
								</div>
							)}
						</div>
					</button>

					{/* Documents section */}
					<div>
						<SectionHeading className="mb-3">
							Documents
						</SectionHeading>

						{allDocs.length > 3 && (
							<input
								type="text"
								className="input input-bordered input-sm w-full mb-3"
								placeholder="Search documents..."
								value={docSearch}
								onChange={(e) =>
									setDocSearch(e.target.value)
								}
							/>
						)}

						{allDocs.length === 0 ? (
							<div className="rounded-xl border border-base-300 bg-base-100 p-8 text-center text-base-content/50">
								<p className="text-base">
									No documents in this folder yet.
								</p>
								<button
									type="button"
									className="btn btn-primary btn-sm mt-4"
									onClick={handleAddDocument}
								>
									Add New Document
								</button>
							</div>
						) : (
							<div className="rounded-xl border border-base-300 bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] divide-y divide-base-200 overflow-hidden">
								{allDocs
									.filter((doc) => {
										if (!docSearch.trim()) return true;
										const q = docSearch
											.trim()
											.toLowerCase();
										return doc.filename
											.toLowerCase()
											.includes(q);
									})
									.map((doc) => (
										<DocumentRow
											key={doc.filename}
											doc={doc}
											onOpen={onOpenDocument}
											onDelete={onDeleteDocument}
											onNewVersion={
												onNewVersionDocument
											}
											onOpenTemplate={
												onOpenTemplateFile
											}
											onReload={onReloadLilyFile}
										/>
									))}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Document Row (from ClientHub) ──────────────────────────────────────

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
		const menuW = 192;
		const menuH = 140;
		const x = Math.min(e.clientX, window.innerWidth - menuW);
		const y = Math.min(e.clientY, window.innerHeight - menuH);
		setMenuPos({ x, y });
	};

	return (
		<>
			<button
				type="button"
				className="w-full text-left px-5 py-4 hover:bg-base-200/60 transition-colors"
				onClick={() => onOpen(doc.filename, doc.templateRelPath)}
				onContextMenu={handleContextMenu}
			>
				<div className="flex flex-col gap-0.5">
					<span className="font-medium text-base">
						{stripDocx(doc.filename)}
					</span>
					<span className="text-sm text-base-content/40">
						from{" "}
						{stripDocx(
							extractFilename(doc.templateRelPath),
						)}
						{" \u00B7 "}
						{formatDate(doc.modifiedAt)}
					</span>
				</div>
			</button>

			{menuPos && (
				<div
					ref={menuRef}
					className="fixed z-50 menu bg-base-100 rounded-box shadow-lg border border-base-300 w-48 p-1"
					style={{ left: menuPos.x, top: menuPos.y }}
				>
					<li>
						<button
							type="button"
							className="text-sm"
							onClick={() => {
								setMenuPos(null);
								onNewVersion(doc.filename);
							}}
						>
							New Version
						</button>
					</li>
					<li>
						<button
							type="button"
							className="text-sm text-error"
							onClick={() => {
								setMenuPos(null);
								setConfirmingDelete(true);
								setTimeout(
									() =>
										deleteDialogRef.current?.showModal(),
									0,
								);
							}}
						>
							Delete
						</button>
					</li>
					<div className="divider my-0" />
					<li>
						<button
							type="button"
							className="text-sm"
							onClick={() => {
								setMenuPos(null);
								onOpenTemplate(doc.templateRelPath);
							}}
						>
							Open Template
						</button>
					</li>
				</div>
			)}

			{confirmingDelete && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close is a convenience
				<dialog
					ref={deleteDialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === deleteDialogRef.current) {
							deleteDialogRef.current?.close();
							setConfirmingDelete(false);
						}
					}}
				>
					<div className="modal-box">
						<h3 className="text-lg font-bold mb-2">
							Delete document?
						</h3>
						<p className="text-base-content/70 mb-4">
							Are you sure you want to delete{" "}
							<strong>{doc.filename}</strong>? This cannot
							be undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									deleteDialogRef.current?.close();
									setConfirmingDelete(false);
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error btn-sm"
								onClick={async () => {
									deleteDialogRef.current?.close();
									setConfirmingDelete(false);
									await onDelete(doc.filename);
								}}
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

// ─── Tree Components ────────────────────────────────────────────────────

function ClientTreeItem({
	node,
	selectedDir,
	onSelectDir,
}: {
	node: ClientTreeNode;
	selectedDir: string | null;
	onSelectDir: (dir: string) => void;
}) {
	const hasChildren = node.children.length > 0;

	if (node.is_client) {
		return (
			<ClientTreeClient
				node={node}
				isSelected={selectedDir === node.path}
				hasChildren={hasChildren}
				onSelect={onSelectDir}
				selectedDir={selectedDir}
			/>
		);
	}

	if (hasChildren) {
		return (
			<ClientTreeFolder
				node={node}
				selectedDir={selectedDir}
				onSelectDir={onSelectDir}
			/>
		);
	}

	return (
		<div className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal gap-2 text-base-content/30 cursor-default">
			<FolderIcon open={false} />
			<span className="truncate">{node.name}</span>
		</div>
	);
}

function ClientTreeFolder({
	node,
	selectedDir,
	onSelectDir,
}: {
	node: ClientTreeNode;
	selectedDir: string | null;
	onSelectDir: (dir: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div>
			<button
				type="button"
				className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-medium gap-2"
				onClick={() => setExpanded(!expanded)}
			>
				<span className="text-xs opacity-40">
					{expanded ? "\u25BE" : "\u25B8"}
				</span>
				<FolderIcon open={expanded} />
				<span className="truncate">{node.name}</span>
			</button>
			{expanded && (
				<div className="ml-4 border-l border-base-300 pl-1">
					{node.children.map((child) => (
						<ClientTreeItem
							key={child.path}
							node={child}
							selectedDir={selectedDir}
							onSelectDir={onSelectDir}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ClientTreeClient({
	node,
	isSelected,
	hasChildren,
	onSelect,
	selectedDir,
}: {
	node: ClientTreeNode;
	isSelected: boolean;
	hasChildren: boolean;
	onSelect: (dir: string) => void;
	selectedDir: string | null;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div>
			<button
				type="button"
				className={`btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal gap-2 ${
					isSelected ? "bg-primary/10 text-primary font-medium" : ""
				}`}
				onClick={() => onSelect(node.path)}
			>
				{hasChildren ? (
					<span
						className="text-xs opacity-40"
						onClick={(e) => {
							e.stopPropagation();
							setExpanded(!expanded);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								setExpanded(!expanded);
							}
						}}
						role="button"
						tabIndex={-1}
					>
						{expanded ? "\u25BE" : "\u25B8"}
					</span>
				) : (
					<span className="w-3" />
				)}
				<ClientIcon />
				<span className="truncate">{node.name}</span>
			</button>
			{hasChildren && expanded && (
				<div className="ml-4 border-l border-base-300 pl-1">
					{node.children.map((child) => (
						<ClientTreeItem
							key={child.path}
							node={child}
							selectedDir={selectedDir}
							onSelectDir={onSelect}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Icons ──────────────────────────────────────────────────────────────

function FolderIcon({ open }: { open: boolean }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>Folder</title>
			{open ? (
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

function ClientIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>Client</title>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
			/>
		</svg>
	);
}

// ─── Progress Tab ────────────────────────────────────────────────────────

function ProgressTab({
	clients,
	stats,
	hasLibraryDirs,
	onGoToSettings,
	lilyIcon,
}: {
	clients: ClientSummary[];
	stats: {
		totalClients: number;
		totalDocs: number;
		byStatus: Record<string, number>;
	};
	hasLibraryDirs: boolean;
	onGoToSettings: () => void;
	lilyIcon: string;
}) {
	if (!hasLibraryDirs) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 p-8">
				<img src={lilyIcon} alt="" className="size-16 opacity-20" />
				<p className="text-base-content/50 text-center max-w-sm">
					Configure a client library folder in Settings to track
					document progress across clients.
				</p>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={onGoToSettings}
				>
					Open Settings
				</button>
			</div>
		);
	}

	const completedDocs =
		(stats.byStatus.complete || 0) + (stats.byStatus.executed || 0);
	const completionPct =
		stats.totalDocs > 0
			? Math.round((completedDocs / stats.totalDocs) * 100)
			: 0;

	return (
		<div className="flex-1 overflow-y-auto p-6">
			<div className="max-w-3xl mx-auto space-y-6">
				<div className="flex gap-4">
					<div className="flex-1 px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
						<div className="text-2xl font-bold">
							{stats.totalClients}
						</div>
						<div className="text-xs text-base-content/50">
							Clients
						</div>
					</div>
					<div className="flex-1 px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
						<div className="text-2xl font-bold">
							{stats.totalDocs}
						</div>
						<div className="text-xs text-base-content/50">
							Required Documents
						</div>
					</div>
					<div className="flex-1 px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
						<div className="text-2xl font-bold">
							{completionPct}%
						</div>
						<div className="text-xs text-base-content/50">
							Complete
						</div>
					</div>
				</div>

				{stats.totalDocs > 0 && (
					<div className="flex gap-2 flex-wrap">
						{(
							Object.entries(STATUS_LABELS) as [
								DocumentStatus,
								string,
							][]
						).map(([status, label]) => {
							const count = stats.byStatus[status] || 0;
							if (count === 0) return null;
							return (
								<span
									key={status}
									className={`badge ${STATUS_BADGES[status]} gap-1`}
								>
									{count} {label}
								</span>
							);
						})}
					</div>
				)}

				<div>
					<SectionHeading className="mb-3">
						By Client
					</SectionHeading>
					{clients.length === 0 ? (
						<p className="text-sm text-base-content/50">
							No clients found.
						</p>
					) : (
						<div className="rounded-xl border border-base-300 bg-base-100 shadow-[0_4px_16px_rgba(0,0,0,0.25)] divide-y divide-base-200 overflow-hidden">
							{clients.map((client) => (
								<div
									key={client.directory}
									className="px-5 py-4"
								>
									<div className="font-medium text-sm mb-2">
										{client.client_name}
									</div>
									{client.required_documents.length ===
									0 ? (
										<p className="text-xs text-base-content/30">
											No required documents
										</p>
									) : (
										<div className="flex flex-wrap gap-1.5">
											{client.required_documents.map(
												(req, i) => (
													<span
														key={`${req.template_rel_path}-${i}`}
														className={`badge badge-sm ${STATUS_BADGES[req.status]} gap-1`}
													>
														{extractTemplateName(
															req.template_rel_path,
														)}
													</span>
												),
											)}
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
