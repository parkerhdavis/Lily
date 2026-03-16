import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";

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
			<h1 className="text-3xl font-bold">Lily</h1>
			<p className="text-base-content/70 text-center max-w-md">
				Select a working directory to get started. This is typically a client
				folder where your completed documents will be saved.
			</p>

			<button
				type="button"
				className="btn btn-primary btn-lg"
				onClick={pickWorkingDir}
			>
				Select Working Directory
			</button>

			{settings.recent_directories.length > 0 && (
				<div className="w-full max-w-md">
					<h2 className="text-sm font-semibold text-base-content/50 mb-2">
						Recent Directories
					</h2>
					<ul className="menu menu-sm bg-base-200 rounded-box gap-1">
						{settings.recent_directories.map((dir) => (
							<li key={dir}>
								<div
									className="flex items-center justify-between gap-2 cursor-pointer"
									onClick={() => selectDirectory(dir)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ")
											selectDirectory(dir);
									}}
								>
									<div className="flex flex-col min-w-0">
										<span className="font-medium truncate">
											{dirName(dir)}
										</span>
										<span className="text-xs text-base-content/40 truncate">
											{dir}
										</span>
									</div>
									<button
										type="button"
										className="btn btn-ghost btn-xs opacity-40 hover:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											removeRecentDirectory(dir);
										}}
										title="Remove from recent"
									>
										✕
									</button>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			<div className="divider w-64">Settings</div>

			<div className="text-center">
				<p className="text-sm text-base-content/50 mb-2">
					Templates folder:{" "}
					<span className="font-mono text-xs">
						{settings.templates_dir ?? "Not configured"}
					</span>
				</p>
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={pickTemplatesDir}
				>
					{settings.templates_dir ? "Change" : "Set"} Templates Folder
				</button>
			</div>
		</div>
	);
}
