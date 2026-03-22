import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import SectionHeading from "@/components/ui/SectionHeading";

export default function DirectoryPicker() {
	const { settings, save, addRecentDirectory, removeRecentDirectory } =
		useSettingsStore();
	const { setWorkingDir, loadTemplates } = useWorkflowStore();

	const selectDirectory = async (dir: string) => {
		await addRecentDirectory(dir);
		save({ last_working_dir: dir });

		if (settings.templates_dir) {
			await loadTemplates(settings.templates_dir);
		}

		setWorkingDir(dir);
	};

	const pickWorkingDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Working Directory (Client Folder)",
			defaultPath: settings.last_working_dir ?? undefined,
		});
		if (selected) {
			await selectDirectory(selected);
		}
	};

	const pickTemplatesDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Templates Folder",
			defaultPath: settings.templates_dir ?? undefined,
		});
		if (selected) {
			save({ templates_dir: selected });
		}
	};

	/** Show just the last path component (the folder name). */
	const dirName = (path: string) => {
		const sep = path.includes("\\") ? "\\" : "/";
		return path.split(sep).filter(Boolean).pop() ?? path;
	};

	return (
		<div className="flex flex-col items-center justify-center min-h-screen gap-8 p-8">
			{/* Branding */}
			<div className="flex flex-col items-center gap-3">
				<img
					src="/lily-icon-trans.png"
					alt="Lily"
					className="size-16 drop-shadow-sm"
				/>
				<div className="text-center">
					<h1 className="text-3xl font-bold tracking-tight">
						Lily
					</h1>
					<p className="text-sm text-base-content/40 mt-1">
						Document preparation for Carelaw Colorado
					</p>
				</div>
			</div>

			<button
				type="button"
				className="btn btn-primary btn-lg shadow-sm"
				onClick={pickWorkingDir}
			>
				Select Working Directory
			</button>

			{settings.recent_directories.length > 0 && (
				<div className="w-full max-w-md">
					<SectionHeading className="mb-2">Recent</SectionHeading>
					<div className="rounded-xl border border-base-300 overflow-hidden divide-y divide-base-200">
						{settings.recent_directories.map((dir) => (
							<div
								key={dir}
								className="flex items-center justify-between gap-2 px-4 py-2.5 cursor-pointer hover:bg-base-200/60 transition-colors"
								onClick={() => selectDirectory(dir)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ")
										selectDirectory(dir);
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

			<div className="divider w-64 text-base-content/30 text-xs">
				Settings
			</div>

			<div className="text-center">
				<p className="text-xs text-base-content/40 mb-1.5">
					Templates folder:{" "}
					<span className="font-mono">
						{settings.templates_dir ?? "Not configured"}
					</span>
				</p>
				<button
					type="button"
					className="btn btn-ghost btn-sm text-base-content/50"
					onClick={pickTemplatesDir}
				>
					{settings.templates_dir ? "Change" : "Set"} Templates
					Folder
				</button>
			</div>
		</div>
	);
}
