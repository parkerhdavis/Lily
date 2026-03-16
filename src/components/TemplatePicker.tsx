import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** Info about an existing document derived from the selected template. */
interface ExistingDoc {
	filename: string;
	modifiedAt: string;
}

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

	// State for the conflict dialog
	const [conflictDocs, setConflictDocs] = useState<ExistingDoc[]>([]);
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
		// Check sidecar for existing documents derived from this template
		const existing: ExistingDoc[] = [];
		if (sidecar?.documents) {
			for (const [filename, meta] of Object.entries(sidecar.documents)) {
				if (meta.template_rel_path === templateRelPath) {
					existing.push({
						filename,
						modifiedAt: meta.modified_at,
					});
				}
			}
		}

		if (existing.length > 0) {
			// Sort by most recently modified first
			existing.sort(
				(a, b) =>
					new Date(b.modifiedAt).getTime() -
					new Date(a.modifiedAt).getTime(),
			);
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

	/** Format an ISO date string to a readable local format. */
	const formatDate = (iso: string): string => {
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
							onClick={() => handleTemplateClick(template)}
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

			{/* Conflict dialog: existing document(s) found for this template */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close is a convenience, not primary interaction */}
			<dialog
				ref={dialogRef}
				className="modal"
				onClick={(e) => {
					// Close on backdrop click
					if (e.target === dialogRef.current) handleCancelDialog();
				}}
			>
				<div className="modal-box">
					<h3 className="text-lg font-bold mb-2">
						Existing document found
					</h3>
					<p className="text-base-content/70 mb-4">
						This working directory already has{" "}
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
