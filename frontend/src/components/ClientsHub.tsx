import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { ClientSummary, DocumentStatus } from "@/types";
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

// ─── Tab types ───────────────────────────────────────────────────────────

type ClientsTab = "clients" | "progress";

// ─── Main component ──────────────────────────────────────────────────────

export default function ClientsHub() {
	const { settings, save, addRecentDirectory } = useSettingsStore();
	const { setWorkingDir, loadTemplates, goToHub, goToSettings } =
		useWorkflowStore();
	const lilyIcon = useLilyIcon();

	const [activeTab, setActiveTab] = useState<ClientsTab>("clients");
	const [clients, setClients] = useState<ClientSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [search, setSearch] = useState("");

	const libraryDirs = settings.client_library_dirs ?? [];

	// Load clients from library dirs
	const loadClients = useCallback(async () => {
		if (libraryDirs.length === 0) {
			setClients([]);
			return;
		}
		setLoading(true);
		try {
			const results: ClientSummary[] = [];
			for (const dir of libraryDirs) {
				try {
					const dirClients = await invoke<ClientSummary[]>(
						"list_clients_in_library",
						{ libraryDir: dir },
					);
					results.push(...dirClients);
				} catch (err) {
					console.error(
						`Failed to list clients in ${dir}:`,
						err,
					);
				}
			}
			results.sort((a, b) => a.client_name.localeCompare(b.client_name));
			setClients(results);
		} finally {
			setLoading(false);
		}
	}, [libraryDirs]);

	useEffect(() => {
		loadClients();
	}, [loadClients]);

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

	const filteredClients = useMemo(() => {
		if (!search.trim()) return clients;
		const q = search.trim().toLowerCase();
		return clients.filter((c) =>
			c.client_name.toLowerCase().includes(q),
		);
	}, [clients, search]);

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
					<ClientsListTab
						clients={filteredClients}
						loading={loading}
						search={search}
						onSearchChange={setSearch}
						showSearch={clients.length > 5}
						hasLibraryDirs={libraryDirs.length > 0}
						onSelectClient={selectClient}
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

// ─── Clients List Tab ────────────────────────────────────────────────────

function ClientsListTab({
	clients,
	loading,
	search,
	onSearchChange,
	showSearch,
	hasLibraryDirs,
	onSelectClient,
	onGoToSettings,
	lilyIcon,
}: {
	clients: ClientSummary[];
	loading: boolean;
	search: string;
	onSearchChange: (v: string) => void;
	showSearch: boolean;
	hasLibraryDirs: boolean;
	onSelectClient: (dir: string) => void;
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
		<div className="flex-1 overflow-y-auto p-6">
			<div className="max-w-3xl mx-auto">
				{showSearch && (
					<input
						type="text"
						className="input input-bordered input-sm w-full mb-4"
						placeholder="Search clients..."
						value={search}
						onChange={(e) => onSearchChange(e.target.value)}
					/>
				)}

				{clients.length === 0 ? (
					<div className="rounded-xl border border-base-300 bg-base-100 p-8 text-center text-base-content/50">
						<p className="text-base">
							{search.trim()
								? "No clients match your search."
								: "No clients found in your library folders."}
						</p>
					</div>
				) : (
					<div className="rounded-xl border border-base-300 bg-base-100 shadow-sm divide-y divide-base-200 overflow-hidden">
						{clients.map((client) => (
							<ClientRow
								key={client.directory}
								client={client}
								onSelect={onSelectClient}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ClientRow({
	client,
	onSelect,
}: {
	client: ClientSummary;
	onSelect: (dir: string) => void;
}) {
	const reqCount = client.required_documents.length;
	const completedCount = client.required_documents.filter(
		(r) => r.status === "complete" || r.status === "executed",
	).length;

	return (
		<button
			type="button"
			className="w-full text-left px-5 py-4 hover:bg-base-200/60 transition-colors"
			onClick={() => onSelect(client.directory)}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col min-w-0">
					<span className="font-medium text-base truncate">
						{client.client_name}
					</span>
					<span className="text-sm text-base-content/40">
						{client.total_documents} document
						{client.total_documents !== 1 ? "s" : ""}
						{client.contacts_count > 0 &&
							` \u00B7 ${client.contacts_count} contact${client.contacts_count !== 1 ? "s" : ""}`}
					</span>
				</div>
				{reqCount > 0 && (
					<div className="flex items-center gap-1.5 shrink-0">
						<span className="text-xs text-base-content/50">
							{completedCount}/{reqCount}
						</span>
						<div className="w-16 h-1.5 bg-base-300 rounded-full overflow-hidden">
							<div
								className="h-full bg-success rounded-full transition-all"
								style={{
									width: `${(completedCount / reqCount) * 100}%`,
								}}
							/>
						</div>
					</div>
				)}
			</div>
		</button>
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
						<div className="rounded-xl border border-base-300 bg-base-100 shadow-sm divide-y divide-base-200 overflow-hidden">
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
