import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQuestionnaireStore } from "@/stores/questionnaireStore";
import { questionnaireDef as fallbackDef } from "@/data/questionnaireDef";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLilyIcon } from "@/hooks/useLilyIcon";
import type { QuestionnaireSectionDef } from "@/types/questionnaire";
import { extractFilename, extractFolderName } from "@/utils/path";

/** Format an ISO date string to a readable local format. */
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

/** Strip the .docx extension from a filename for display. */
function stripDocx(name: string): string {
	return name.replace(/\.docx$/i, "");
}


interface ClientDoc {
	filename: string;
	templateRelPath: string;
	modifiedAt: string;
}

export default function ClientHub() {
	const {
		workingDir,
		lilyFile,
		loading,
		error,
		openDocument,
		startAddDocument,
		openQuestionnaire,
		deleteDocument,
		newVersionDocument,
		openTemplateFile,
		loadTemplates,
		reloadLilyFile,
		reset,
	} = useWorkflowStore();
	const { settings } = useSettingsStore();
	const { loadActiveQuestionnaire } = useQuestionnaireStore();
	const lilyIcon = useLilyIcon();

	const [docSearch, setDocSearch] = useState("");

	// Dynamic questionnaire definition for stats
	const [qDef, setQDef] = useState<QuestionnaireSectionDef[]>(fallbackDef);
	useEffect(() => {
		(async () => {
			try {
				let def = null;
				if (lilyFile?.questionnaire_id) {
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
	}, [lilyFile?.questionnaire_id, loadActiveQuestionnaire]);

	// Build client documents list from .lily file, sorted by modification date
	const allDocs = useMemo(() => {
		if (!lilyFile?.documents) return [];
		return Object.entries(lilyFile.documents)
			.map(([filename, meta]) => ({
				filename,
				templateRelPath: meta.template_rel_path,
				modifiedAt: meta.modified_at,
			}))
			.sort(
				(a, b) =>
					new Date(b.modifiedAt).getTime() -
					new Date(a.modifiedAt).getTime(),
			);
	}, [lilyFile]);

	// Compute questionnaire completion stats from the definition + variables
	const questionnaireStats = useMemo(() => {
		const vars = lilyFile?.variables ?? {};
		const contactCount = lilyFile?.contacts?.length ?? 0;
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
			loadTemplates(settings.templates_dir);
		}
		startAddDocument();
	};

	const folderName = workingDir ? extractFolderName(workingDir) : "Client";
	const contactCount = lilyFile?.contacts?.length ?? 0;

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3">
				<img
					src={lilyIcon}
					alt="Loading..."
					className="size-12 animate-lily-spin"
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<PageHeader
				title={folderName}
				subtitle={workingDir ?? undefined}
				onBack={reset}
			>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={handleAddDocument}
				>
					+ New Document
				</button>
			</PageHeader>

			{error && (
				<div className="alert alert-error m-4">
					<span>{error}</span>
				</div>
			)}

			{/* Main content area — full width, padded */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-3xl mx-auto space-y-6">
					{/* Questionnaire card */}
					<button
						type="button"
						className="w-full text-left p-5 rounded-xl border-2 border-primary/40 bg-base-100 shadow-sm hover:shadow-md transition-shadow"
						onClick={openQuestionnaire}
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
											"--value":
												questionnaireStats.total > 0
													? Math.round(
															(questionnaireStats.filled /
																questionnaireStats.total) *
																100,
														)
													: 0,
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
								onChange={(e) => setDocSearch(e.target.value)}
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
							<div className="rounded-xl border border-base-300 bg-base-100 shadow-sm divide-y divide-base-200 overflow-hidden">
								{allDocs
									.filter((doc) => {
										if (!docSearch.trim()) return true;
										const q = docSearch.trim().toLowerCase();
										return doc.filename.toLowerCase().includes(q);
									})
									.map((doc) => (
									<DocumentRow
										key={doc.filename}
										doc={doc}
										onOpen={openDocument}
										onDelete={deleteDocument}
										onNewVersion={newVersionDocument}
										onOpenTemplate={openTemplateFile}
										onReload={reloadLilyFile}
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

// ─── Sub-components ─────────────────────────────────────────────────────────

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

	// Close the context menu when clicking outside
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
		const menuW = 192; // w-48
		const menuH = 140; // approximate menu height
		const x = Math.min(e.clientX, window.innerWidth - menuW);
		const y = Math.min(e.clientY, window.innerHeight - menuH);
		setMenuPos({ x, y });
	};

	const handleNewVersion = async () => {
		setMenuPos(null);
		await onNewVersion(doc.filename);
	};

	const handleDeleteClick = () => {
		setMenuPos(null);
		setConfirmingDelete(true);
		setTimeout(() => deleteDialogRef.current?.showModal(), 0);
	};

	const handleConfirmDelete = async () => {
		deleteDialogRef.current?.close();
		setConfirmingDelete(false);
		await onDelete(doc.filename);
	};

	const handleCancelDelete = () => {
		deleteDialogRef.current?.close();
		setConfirmingDelete(false);
	};

	const handleOpenTemplate = async () => {
		setMenuPos(null);
		await onOpenTemplate(doc.templateRelPath);
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

			{/* Context menu */}
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
							onClick={handleNewVersion}
						>
							New Version
						</button>
					</li>
					<li>
						<button
							type="button"
							className="text-sm text-error"
							onClick={handleDeleteClick}
						>
							Delete
						</button>
					</li>
					<div className="divider my-0" />
					<li>
						<button
							type="button"
							className="text-sm"
							onClick={handleOpenTemplate}
						>
							Open Template
						</button>
					</li>
				</div>
			)}

			{/* Delete confirmation dialog */}
			{confirmingDelete && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close is a convenience
				<dialog
					ref={deleteDialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === deleteDialogRef.current)
							handleCancelDelete();
					}}
				>
					<div className="modal-box">
						<h3 className="text-lg font-bold mb-2">
							Delete document?
						</h3>
						<p className="text-base-content/70 mb-4">
							Are you sure you want to delete{" "}
							<strong>{doc.filename}</strong>? This cannot be
							undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={handleCancelDelete}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error btn-sm"
								onClick={handleConfirmDelete}
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
