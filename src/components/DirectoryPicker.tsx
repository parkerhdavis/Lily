import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";

const QUESTIONNAIRE_FILENAME = "ClientQuestionnaire.docx";

export default function DirectoryPicker() {
	const { settings, save } = useSettingsStore();
	const { setWorkingDir, loadTemplates, selectTemplate, templates } =
		useWorkflowStore();

	const pickWorkingDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Working Directory (Client Folder)",
			defaultPath: settings.last_working_dir ?? undefined,
		});
		if (selected) {
			save({ last_working_dir: selected });

			// Load templates first if we have a templates dir configured,
			// so we can check for a ClientQuestionnaire.docx
			if (settings.templates_dir) {
				await loadTemplates(settings.templates_dir);
			}

			setWorkingDir(selected);

			// If this is a brand-new client folder (no .lily file with
			// documents yet), auto-copy the ClientQuestionnaire.docx if it
			// exists at the root of the templates directory.
			// We check after a brief delay to let the .lily file load complete.
			if (settings.templates_dir) {
				const currentTemplates = useWorkflowStore.getState().templates;
				const hasQuestionnaire = currentTemplates.includes(
					QUESTIONNAIRE_FILENAME,
				);

				if (hasQuestionnaire) {
					// Wait for the .lily file to load, then check if it's empty
					const checkAndCopy = () => {
						const { lilyFile } = useWorkflowStore.getState();
						if (lilyFile !== null) {
							if (Object.keys(lilyFile.documents).length === 0) {
								selectTemplate(
									QUESTIONNAIRE_FILENAME,
									settings.templates_dir!,
								);
							}
							return;
						}
						// .lily file hasn't loaded yet, try again shortly
						setTimeout(checkAndCopy, 50);
					};
					checkAndCopy();
				}
			}
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
