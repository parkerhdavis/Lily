import { invoke } from "@tauri-apps/api/core";
import type { LilyFile, VariableInfo } from "@/types";
import { useUndoStore } from "@/stores/undoStore";
import { useToastStore } from "@/stores/toastStore";
import { extractFilename } from "@/utils/path";
import { pushNav } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createProjectSlice: WorkflowSlice = (set, get) => ({
	setWorkingDir: (dir) => {
		pushNav(get());
		set({ workingDir: dir, step: "client-hub" });

		invoke<LilyFile>("load_lily_file_cmd", { workingDir: dir })
			.then((lilyFile) => {
				set({ lilyFile });
				for (const w of lilyFile.warnings ?? []) {
					useToastStore.getState().addToast("warning", w);
				}
			})
			.catch((err) =>
				console.error("Failed to load .lily file:", err),
			);
	},

	reloadLilyFile: async () => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			const lilyFile = await invoke<LilyFile>("load_lily_file_cmd", {
				workingDir,
			});
			set({ lilyFile });
		} catch (err) {
			console.error("Failed to reload .lily file:", err);
		}
	},

	saveQuestionnaireNote: async (section, noteKind, value) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldValue =
			get().lilyFile?.questionnaire_notes?.[section]?.[noteKind] ?? "";
		await invoke("save_questionnaire_note", {
			workingDir,
			section,
			noteKind,
			value,
		});
		const { lilyFile } = get();
		if (lilyFile) {
			const notes = { ...(lilyFile.questionnaire_notes ?? {}) };
			const sectionNotes = notes[section] ?? {
				client: "",
				internal: "",
			};
			notes[section] = { ...sectionNotes, [noteKind]: value };
			set({
				lilyFile: { ...lilyFile, questionnaire_notes: notes },
			});
		}
		useUndoStore.getState().push({
			description: `Change ${noteKind} note for ${section}`,
			timestamp: Date.now(),
			redo: async () => {
				await invoke("save_questionnaire_note", {
					workingDir,
					section,
					noteKind,
					value,
				});
				const { lilyFile: lf } = get();
				if (lf) {
					const notes = {
						...(lf.questionnaire_notes ?? {}),
					};
					const sn = notes[section] ?? {
						client: "",
						internal: "",
					};
					notes[section] = { ...sn, [noteKind]: value };
					set({
						lilyFile: {
							...lf,
							questionnaire_notes: notes,
						},
					});
				}
			},
			undo: async () => {
				await invoke("save_questionnaire_note", {
					workingDir,
					section,
					noteKind,
					value: oldValue,
				});
				const { lilyFile: lf } = get();
				if (lf) {
					const notes = {
						...(lf.questionnaire_notes ?? {}),
					};
					const sn = notes[section] ?? {
						client: "",
						internal: "",
					};
					notes[section] = { ...sn, [noteKind]: oldValue };
					set({
						lilyFile: {
							...lf,
							questionnaire_notes: notes,
						},
					});
				}
			},
		});
	},

	restoreNavigationEntry: async (entry) => {
		const current = get();
		const needsLilyReload =
			entry.workingDir !== current.workingDir && entry.workingDir;
		const needsDocReload =
			entry.documentPath && entry.documentPath !== current.documentPath;

		set({
			step: entry.step,
			workingDir: entry.workingDir,
			documentPath: entry.documentPath,
			templateRelPath: entry.templateRelPath,
		});

		if (needsLilyReload) {
			try {
				const lilyFile = await invoke<LilyFile>("load_lily_file_cmd", {
					workingDir: entry.workingDir,
				});
				set({ lilyFile });
			} catch (err) {
				console.error("Failed to reload .lily file:", err);
			}
		}

		if (needsDocReload && entry.step === "edit-variables") {
			try {
				const documentHtml = await invoke<string>(
					"get_document_html",
					{ docxPath: entry.documentPath },
				);
				let variables = await invoke<VariableInfo[]>(
					"extract_variables",
					{ docxPath: entry.documentPath },
				);
				const { lilyFile } = get();
				const conditionalSet = new Set(
					lilyFile?.conditional_variables ?? [],
				);
				if (conditionalSet.size > 0) {
					variables = variables.map((v) =>
						conditionalSet.has(v.display_name)
							? { ...v, is_conditional: true }
							: v,
					);
				}
				if (variables.length === 0) {
					const filename = entry.documentPath
						? extractFilename(entry.documentPath)
						: "";
					const storedNames =
						lilyFile?.documents[filename]?.variable_names ?? [];
					if (storedNames.length > 0) {
						variables = storedNames.map((name) => ({
							display_name: name,
							variants: [name],
							is_conditional: conditionalSet.has(name),
						}));
					}
				}
				const savedVars = lilyFile?.variables ?? {};
				const variableValues: Record<string, string> = {};
				for (const v of variables) {
					const defaultVal = v.is_conditional ? "false" : "";
					variableValues[v.display_name] =
						savedVars[v.display_name] ?? defaultVal;
				}
				set({ documentHtml, variables, variableValues, dirty: false });
			} catch (err) {
				console.error("Failed to reload document:", err);
			}
		}
	},
});
