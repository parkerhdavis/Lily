import { invoke } from "@tauri-apps/api/core";
import type { VariableInfo, TextOccurrence } from "@/types";
import { pushNav, toastError, toastSuccess } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createTemplateEditorSlice: WorkflowSlice = (set, get) => ({
	templateEditorPath: null,
	templateEditorHtml: "",
	templateEditorVars: [],
	templateEditorRelPath: null,
	templateEditorDirty: false,

	openTemplateEditor: async (relPath, templatesDir) => {
		const fullPath = `${templatesDir}/${relPath}`;
		pushNav(get());
		set({
			step: "template-editor",
			templateEditorRelPath: relPath,
			templateEditorPath: fullPath,
			templateEditorDirty: false,
			loading: true,
			error: null,
		});

		try {
			// Create backup for safe editing
			await invoke("begin_template_editing", {
				templatePath: fullPath,
				templatesDir,
				templateRelPath: relPath,
			});

			const [html, vars] = await Promise.all([
				invoke<string>("get_document_html", { docxPath: fullPath }),
				invoke<VariableInfo[]>("extract_variables", {
					docxPath: fullPath,
				}),
			]);
			set({
				templateEditorHtml: html,
				templateEditorVars: vars,
				loading: false,
			});
		} catch (err) {
			set({ loading: false });
			toastError("Failed to load template", err);
		}
	},

	insertTemplateVariable: async (
		searchText,
		variableName,
		occurrenceIndex?,
		replaceAll?,
	) => {
		const { templateEditorPath } = get();
		if (!templateEditorPath) return;

		try {
			const vars = await invoke<VariableInfo[]>(
				"insert_template_variable",
				{
					templatePath: templateEditorPath,
					searchText,
					variableName,
					occurrenceIndex: occurrenceIndex ?? null,
					replaceAll: replaceAll ?? null,
				},
			);

			// Refresh preview
			const html = await invoke<string>("get_document_html", {
				docxPath: templateEditorPath,
			});

			set({
				templateEditorVars: vars,
				templateEditorHtml: html,
				templateEditorDirty: true,
			});
			toastSuccess(`Inserted {${variableName}}`);
		} catch (err) {
			toastError("Failed to insert variable", err);
			throw err; // let the UI handle disambiguation
		}
	},

	removeTemplateVariable: async (
		variableName,
		replacementText,
		occurrenceIndex?,
	) => {
		const { templateEditorPath } = get();
		if (!templateEditorPath) return;

		try {
			const vars = await invoke<VariableInfo[]>(
				"remove_template_variable",
				{
					templatePath: templateEditorPath,
					variableName,
					replacementText,
					occurrenceIndex: occurrenceIndex ?? null,
				},
			);

			const html = await invoke<string>("get_document_html", {
				docxPath: templateEditorPath,
			});

			set({
				templateEditorVars: vars,
				templateEditorHtml: html,
				templateEditorDirty: true,
			});
			toastSuccess(`Removed {${variableName}}`);
		} catch (err) {
			toastError("Failed to remove variable", err);
		}
	},

	findTextOccurrences: async (searchText) => {
		const { templateEditorPath } = get();
		if (!templateEditorPath) return [];

		return invoke<TextOccurrence[]>("get_template_text_occurrences", {
			templatePath: templateEditorPath,
			searchText,
		});
	},

	confirmTemplateEdits: async () => {
		const { templateEditorPath, templateEditorRelPath } = get();
		if (!templateEditorPath || !templateEditorRelPath) return;

		const templatesDir =
			(await import("@/stores/settingsStore")).useSettingsStore.getState()
				.settings.templates_dir;
		if (!templatesDir) return;

		try {
			await invoke("confirm_template_edits", {
				templatePath: templateEditorPath,
				templatesDir,
				templateRelPath: templateEditorRelPath,
			});
			set({ templateEditorDirty: false });
			toastSuccess("Template saved");
		} catch (err) {
			toastError("Failed to save template", err);
		}
	},

	discardTemplateEdits: async () => {
		const { templateEditorPath, templateEditorRelPath } = get();
		if (!templateEditorPath || !templateEditorRelPath) return;

		const templatesDir =
			(await import("@/stores/settingsStore")).useSettingsStore.getState()
				.settings.templates_dir;
		if (!templatesDir) return;

		try {
			await invoke("discard_template_edits", {
				templatePath: templateEditorPath,
				templatesDir,
				templateRelPath: templateEditorRelPath,
			});

			// Reload from restored file
			const [html, vars] = await Promise.all([
				invoke<string>("get_document_html", {
					docxPath: templateEditorPath,
				}),
				invoke<VariableInfo[]>("extract_variables", {
					docxPath: templateEditorPath,
				}),
			]);

			set({
				templateEditorHtml: html,
				templateEditorVars: vars,
				templateEditorDirty: false,
			});
			toastSuccess("Changes discarded");
		} catch (err) {
			toastError("Failed to discard changes", err);
		}
	},

	moveTemplateSdt: async (sdtId, targetParaIdx, targetCharOffset) => {
		const { templateEditorPath } = get();
		if (!templateEditorPath) return;

		try {
			const vars = await invoke<VariableInfo[]>("move_template_sdt", {
				templatePath: templateEditorPath,
				sdtId,
				targetParagraphIndex: targetParaIdx,
				targetCharOffset,
			});

			const html = await invoke<string>("get_document_html", {
				docxPath: templateEditorPath,
			});

			set({
				templateEditorVars: vars,
				templateEditorHtml: html,
				templateEditorDirty: true,
			});
			toastSuccess("Variable moved");
		} catch (err) {
			toastError("Failed to move variable", err);
		}
	},

	insertSdtAtPosition: async (variableName, paraIdx, charOffset) => {
		const { templateEditorPath } = get();
		if (!templateEditorPath) return;

		try {
			const vars = await invoke<VariableInfo[]>(
				"insert_sdt_at_position",
				{
					templatePath: templateEditorPath,
					variableName,
					paragraphIndex: paraIdx,
					charOffset,
				},
			);

			const html = await invoke<string>("get_document_html", {
				docxPath: templateEditorPath,
			});

			set({
				templateEditorVars: vars,
				templateEditorHtml: html,
				templateEditorDirty: true,
			});
			toastSuccess(`Inserted {${variableName}}`);
		} catch (err) {
			toastError("Failed to insert variable", err);
		}
	},

	returnFromTemplateEditor: () => {
		pushNav(get());
		set({
			step: "pipeline",
			templateEditorPath: null,
			templateEditorHtml: "",
			templateEditorVars: [],
			templateEditorRelPath: null,
			templateEditorDirty: false,
		});
	},
});
