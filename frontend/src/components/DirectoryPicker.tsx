import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";

export default function DirectoryPicker() {
	const { settings, save } = useSettingsStore();
	const { setWorkingDir, loadTemplates } = useWorkflowStore();

	const pickWorkingDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Working Directory (Client Folder)",
			defaultPath: settings.last_working_dir ?? undefined,
		});
		if (selected) {
			save({ last_working_dir: selected });

			if (settings.templates_dir) {
				await loadTemplates(settings.templates_dir);
			}

			setWorkingDir(selected);
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
