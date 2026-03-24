import { invoke } from "@tauri-apps/api/core";
import type { VariableInfo, TextOccurrence } from "@/types";
import { pushNav, toastError, toastSuccess } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createTemplateEditorSlice: WorkflowSlice = (set, get) => ({
	templateEditorPath: null,
	templateEditorHtml: "",
	templateEditorVars: [],
	templateEditorRelPath: null,

	openTemplateEditor: async (relPath, templatesDir) => {
		const fullPath = `${templatesDir}/${relPath}`;
		pushNav(get());
		set({
			step: "template-editor",
			templateEditorRelPath: relPath,
			templateEditorPath: fullPath,
			loading: true,
			error: null,
		});

		try {
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

	returnFromTemplateEditor: () => {
		pushNav(get());
		set({
			step: "pipeline",
			templateEditorPath: null,
			templateEditorHtml: "",
			templateEditorVars: [],
			templateEditorRelPath: null,
		});
	},
});
