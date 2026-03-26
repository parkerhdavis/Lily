import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import type {
	ClientSummary,
	ClientTreeNode,
	DocumentStatus,
} from "@/types";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLilyIcon } from "@/hooks/useLilyIcon";
import { extractFolderName } from "@/utils/path";

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

// ─── Tree helpers ────────────────────────────────────────────────────────

/** Recursively extract all ClientSummary objects from a tree. */
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

// ─── Main component ──────────────────────────────────────────────────────

export default function ClientsHub() {
	const { settings, save, addRecentDirectory } = useSettingsStore();
	const { setWorkingDir, loadTemplates, goToHub, goToSettings } =
		useWorkflowStore();
	const lilyIcon = useLilyIcon();

	const [activeTab, setActiveTab] = useState<ClientsTab>("clients");
	const [trees, setTrees] = useState<LibraryTree[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedDir, setSelectedDir] = useState<string | null>(null);

	const libraryDirs = settings.client_library_dirs;

	// Load folder trees from library dirs
	const loadTrees = useCallback(async () => {
		if (!libraryDirs || libraryDirs.length === 0) {
			setTrees([]);
			return;
		}
		setLoading(true);
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
			setLoading(false);
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

	// Find the selected client summary from the tree
	const selectedClient = useMemo(() => {
		if (!selectedDir) return null;
		return clients.find((c) => c.directory === selectedDir) ?? null;
	}, [selectedDir, clients]);

	const openClient = async (dir: string) => {
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
			await openClient(selected);
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
						loading={loading}
						hasLibraryDirs={libraryDirs.length > 0}
						selectedDir={selectedDir}
						selectedClient={selectedClient}
						onSelectDir={setSelectedDir}
						onOpenClient={openClient}
						onGoToSettings={goToSettings}
						lilyIcon={lilyIcon}
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
	selectedDir,
	selectedClient,
	onSelectDir,
	onOpenClient,
	onGoToSettings,
	lilyIcon,
}: {
	trees: LibraryTree[];
	loading: boolean;
	hasLibraryDirs: boolean;
	selectedDir: string | null;
	selectedClient: ClientSummary | null;
	onSelectDir: (dir: string) => void;
	onOpenClient: (dir: string) => void;
	onGoToSettings: () => void;
	lilyIcon: string;
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
										selectedDir={selectedDir}
										onSelectDir={onSelectDir}
										onOpenClient={onOpenClient}
									/>
								))}
							</div>
						)}
					</div>
				))}
			</div>

			{/* Right pane: client details */}
			<div className="flex-1 overflow-y-auto p-6">
				{selectedClient ? (
					<ClientDetails
						client={selectedClient}
						onOpen={onOpenClient}
					/>
				) : (
					<div className="flex items-center justify-center h-full text-base-content/40 text-sm">
						Select a client to view details
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Tree Components ────────────────────────────────────────────────────

function ClientTreeItem({
	node,
	selectedDir,
	onSelectDir,
	onOpenClient,
}: {
	node: ClientTreeNode;
	selectedDir: string | null;
	onSelectDir: (dir: string) => void;
	onOpenClient: (dir: string) => void;
}) {
	const hasChildren = node.children.length > 0;

	if (node.is_client) {
		return (
			<ClientTreeClient
				node={node}
				isSelected={selectedDir === node.path}
				hasChildren={hasChildren}
				onSelect={onSelectDir}
				onOpen={onOpenClient}
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
				onOpenClient={onOpenClient}
			/>
		);
	}

	// Empty non-client folder
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
	onOpenClient,
}: {
	node: ClientTreeNode;
	selectedDir: string | null;
	onSelectDir: (dir: string) => void;
	onOpenClient: (dir: string) => void;
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
							onOpenClient={onOpenClient}
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
	onOpen,
	selectedDir,
}: {
	node: ClientTreeNode;
	isSelected: boolean;
	hasChildren: boolean;
	onSelect: (dir: string) => void;
	onOpen: (dir: string) => void;
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
				onDoubleClick={() => onOpen(node.path)}
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
							onOpenClient={onOpen}
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

// ─── Client Details Panel ───────────────────────────────────────────────

function ClientDetails({
	client,
	onOpen,
}: {
	client: ClientSummary;
	onOpen: (dir: string) => void;
}) {
	const reqCount = client.required_documents.length;
	const completedCount = client.required_documents.filter(
		(r) => r.status === "complete" || r.status === "executed",
	).length;

	return (
		<div className="max-w-lg">
			<h3 className="text-xl font-semibold mb-1">
				{client.client_name}
			</h3>
			<p className="text-xs text-base-content/40 mb-4 font-mono">
				{client.directory}
			</p>

			<button
				type="button"
				className="btn btn-primary btn-sm mb-6"
				onClick={() => onOpen(client.directory)}
			>
				Open Client
			</button>

			{/* Summary cards */}
			<div className="flex gap-4 mb-6">
				<div className="px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
					<div className="text-2xl font-bold">
						{client.total_documents}
					</div>
					<div className="text-xs text-base-content/50">
						Documents
					</div>
				</div>
				<div className="px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
					<div className="text-2xl font-bold">
						{client.contacts_count}
					</div>
					<div className="text-xs text-base-content/50">
						Contacts
					</div>
				</div>
				{reqCount > 0 && (
					<div className="px-4 py-3 rounded-lg bg-base-100 border border-base-300 text-center">
						<div className="text-2xl font-bold">
							{Math.round(
								(completedCount / reqCount) * 100,
							)}
							%
						</div>
						<div className="text-xs text-base-content/50">
							Complete
						</div>
					</div>
				)}
			</div>

			{/* Required documents */}
			{reqCount > 0 && (
				<div>
					<SectionHeading className="mb-2">
						Required Documents
					</SectionHeading>
					<div className="rounded-xl border border-base-300 divide-y divide-base-200">
						{client.required_documents.map((req, i) => (
							<div
								key={`${req.template_rel_path}-${i}`}
								className="px-3 py-2 text-sm flex items-center justify-between gap-2"
							>
								<span>
									{extractTemplateName(
										req.template_rel_path,
									)}
								</span>
								<span
									className={`badge badge-sm ${STATUS_BADGES[req.status]}`}
								>
									{STATUS_LABELS[req.status]}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
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
				{/* Summary cards */}
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

				{/* Status breakdown */}
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

				{/* Per-client breakdown */}
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
