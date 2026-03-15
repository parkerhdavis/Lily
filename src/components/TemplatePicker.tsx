import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";

export default function TemplatePicker() {
	const { templates, loading, error, selectTemplate, setStep } =
		useWorkflowStore();
	const { settings } = useSettingsStore();

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	if (!settings.templates_dir) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8">
				<p className="text-error">
					No templates folder configured. Please go back and set one.
				</p>
				<button
					type="button"
					className="btn btn-ghost"
					onClick={() => setStep("select-directory")}
				>
					Back
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-screen p-8">
			<div className="flex items-center gap-4 mb-6">
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={() => setStep("select-directory")}
				>
					&larr; Back
				</button>
				<h2 className="text-2xl font-bold">Select a Template</h2>
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			{templates.length === 0 ? (
				<p className="text-base-content/50">
					No .docx templates found in the configured folder.
				</p>
			) : (
				<div className="grid gap-2 max-w-3xl">
					{templates.map((template) => (
						<button
							type="button"
							key={template}
							className="btn btn-ghost justify-start text-left h-auto py-3 px-4 font-normal"
							onClick={() =>
								selectTemplate(template, settings.templates_dir!)
							}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="h-5 w-5 shrink-0 opacity-50"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<title>Document icon</title>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
							<span className="ml-2">{template}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
