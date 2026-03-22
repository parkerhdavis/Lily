import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import SectionHeading from "@/components/ui/SectionHeading";
import AppSwitcher from "@/components/ui/AppSwitcher";

export default function LilyHub() {
	const { settings, save, addRecentDirectory, removeRecentDirectory } =
		useSettingsStore();
	const { setWorkingDir, loadTemplates, goToSettings, goToPipeline } =
		useWorkflowStore();

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

	/** Show just the last path component (the folder name). */
	const dirName = (path: string) => {
		const sep = path.includes("\\") ? "\\" : "/";
		return path.split(sep).filter(Boolean).pop() ?? path;
	};

	return (
		<div className="flex flex-col min-h-screen p-8">
			{/* Top bar: branding + app switcher */}
			<div className="flex items-start justify-between mb-8">
				<div className="flex items-center gap-3">
					<img
						src="/lily-icon-trans.png"
						alt="Lily"
						className="size-10 drop-shadow-sm"
					/>
					<div>
						<h1 className="text-2xl font-bold tracking-tight">
							Lily
						</h1>
						<p className="text-xs text-base-content/40">
							Document preparation for Carelaw Colorado
						</p>
					</div>
				</div>
				<AppSwitcher />
			</div>

			{/* Main content: two-column layout */}
			<div className="flex gap-6 flex-1 max-w-4xl mx-auto w-full">
				{/* Left column: Clients (primary) */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center justify-between mb-4">
						<SectionHeading>Clients</SectionHeading>
					</div>

					<button
						type="button"
						className="btn btn-primary w-full mb-4"
						onClick={pickClientFolder}
					>
						Open Client Folder
					</button>

					{settings.recent_directories.length > 0 && (
						<div>
							<p className="text-xs text-base-content/40 mb-2">
								Recent
							</p>
							<div className="rounded-xl border border-base-300 overflow-hidden divide-y divide-base-200">
								{settings.recent_directories.map((dir) => (
									<div
										key={dir}
										className="flex items-center justify-between gap-2 px-4 py-2.5 cursor-pointer hover:bg-base-200/60 transition-colors"
										onClick={() => selectClient(dir)}
										onKeyDown={(e) => {
											if (
												e.key === "Enter" ||
												e.key === " "
											)
												selectClient(dir);
										}}
										role="button"
										tabIndex={0}
									>
										<div className="flex flex-col min-w-0">
											<span className="font-medium text-sm truncate">
												{dirName(dir)}
											</span>
											<span className="text-xs text-base-content/35 truncate">
												{dir}
											</span>
										</div>
										<button
											type="button"
											className="btn btn-ghost btn-xs opacity-30 hover:opacity-100 text-base-content/50"
											onClick={(e) => {
												e.stopPropagation();
												removeRecentDirectory(dir);
											}}
											title="Remove from recent"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												viewBox="0 0 20 20"
												fill="currentColor"
												className="size-3.5"
											>
												<title>Remove</title>
												<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
											</svg>
										</button>
									</div>
								))}
							</div>
						</div>
					)}

					{settings.recent_directories.length === 0 && (
						<div className="text-sm text-base-content/40 text-center py-8">
							<p>No recent clients.</p>
							<p className="mt-1">
								Open a client folder to get started.
							</p>
						</div>
					)}
				</div>

				{/* Right column: secondary cards */}
				<div className="w-64 shrink-0 flex flex-col gap-4">
					{/* Pipeline card */}
					<button
						type="button"
						className="card bg-base-100 border border-base-300 hover:bg-base-100/80 transition-colors text-left"
						onClick={goToPipeline}
					>
						<div className="card-body p-4 gap-1">
							<div className="flex items-center gap-2">
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4 text-base-content/50">
									<title>Pipeline</title>
									<path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26a3.235 3.235 0 0 1 1.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" />
								</svg>
								<span className="font-semibold text-sm">
									Pipeline
								</span>
							</div>
							<p className="text-xs text-base-content/40">
								Templates, processes, and workspace
								configuration
							</p>
						</div>
					</button>

					{/* Settings card */}
					<button
						type="button"
						className="card bg-base-100 border border-base-300 hover:bg-base-100/80 transition-colors text-left"
						onClick={goToSettings}
					>
						<div className="card-body p-4 gap-1">
							<div className="flex items-center gap-2">
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4 text-base-content/50">
									<title>Settings</title>
									<path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
								</svg>
								<span className="font-semibold text-sm">
									Settings
								</span>
							</div>
							<p className="text-xs text-base-content/40">
								Theme, templates folder, and preferences
							</p>
						</div>
					</button>
				</div>
			</div>
		</div>
	);
}
