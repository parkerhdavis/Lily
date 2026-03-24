import { invoke } from "@tauri-apps/api/core";
import type { LilyFile, VariableInfo, VariableSchema } from "@/types";
import { useUndoStore } from "@/stores/undoStore";
import { extractFilename } from "@/utils/path";
import { pushNav, toastError, toastSuccess } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createDocumentSlice: WorkflowSlice = (set, get) => ({
	loadTemplates: async (templatesDir) => {
		set({ loading: true, error: null });
		try {
			const templates = await invoke<string[]>("list_templates", {
				templatesDir,
			});
			set({ templates, loading: false });
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to load templates", err);
		}
	},

	selectTemplate: async (templateRelPath, templatesDir) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		set({ loading: true, error: null });
		try {
			const fullTemplatePath = `${templatesDir}/${templateRelPath}`;

			let filename = extractFilename(templateRelPath);
			if (filename.toLowerCase().endsWith(".dotx")) {
				filename = `${filename.slice(0, -5)}.docx`;
			}

			const docPath = await invoke<string>("copy_template", {
				templatePath: fullTemplatePath,
				destDir: workingDir,
				filename,
				templateRelPath,
			});

			const variables = await invoke<VariableInfo[]>(
				"extract_variables",
				{ docxPath: docPath },
			);

			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			const savedVars = lilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				const defaultVal = v.is_conditional ? "false" : "";
				variableValues[v.display_name] =
					savedVars[v.display_name] ?? defaultVal;
			}

			const conditionalDefs: Record<string, string[]> = {};
			for (const v of variables) {
				if (v.is_conditional) {
					conditionalDefs[v.display_name] = v.variants;
				}
			}

			await invoke("set_document_variables", {
				workingDir,
				filename,
				variableNames: variables.map((v) => v.display_name),
				conditionalNames: variables
					.filter((v) => v.is_conditional)
					.map((v) => v.display_name),
				conditionalDefinitions: conditionalDefs,
			});

			const updatedLilyFile = await invoke<LilyFile>(
				"load_lily_file_cmd",
				{ workingDir },
			);

			// Load template schema (if it exists) for type-specific inputs
			let templateSchema: VariableSchema | null = null;
			try {
				templateSchema = await invoke<VariableSchema>(
					"load_template_schema",
					{ templatesDir, templateRelPath },
				);
			} catch {
				// Schema is optional — continue without it
			}

			// Apply schema defaults to unfilled variables
			if (templateSchema) {
				for (const v of variables) {
					if (!variableValues[v.display_name]) {
						const entry = templateSchema.variables[v.display_name];
						if (entry?.default) {
							variableValues[v.display_name] = entry.default;
						}
					}
				}
			}

			pushNav(get());
			set({
				documentPath: docPath,
				templateRelPath,
				variables,
				variableValues,
				documentHtml,
				lilyFile: updatedLilyFile,
				templateSchema,
				dirty: false,
				step: "edit-variables",
				loading: false,
			});
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to prepare document", err);
		}
	},

	openDocument: async (filename, templateRelPath) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		set({ loading: true, error: null });
		try {
			const docPath = `${workingDir}/${filename}`;

			let variables = await invoke<VariableInfo[]>("extract_variables", {
				docxPath: docPath,
			});

			if (variables.length === 0) {
				const storedNames =
					lilyFile?.documents[filename]?.variable_names ?? [];
				if (storedNames.length > 0) {
					variables = storedNames.map((name) => ({
						display_name: name,
						variants: [name],
						is_conditional: false,
					}));
				}
			}

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

			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			const savedVars = lilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				const defaultVal = v.is_conditional ? "false" : "";
				variableValues[v.display_name] =
					savedVars[v.display_name] ?? defaultVal;
			}

			const docMeta = lilyFile?.documents[filename];
			if (docMeta?.role_overrides) {
				for (const override of Object.values(docMeta.role_overrides)) {
					for (const [varName, value] of Object.entries(
						override.values,
					)) {
						variableValues[varName] = value;
					}
				}
			}

			// Load template schema for type-specific inputs
			let templateSchema: VariableSchema | null = null;
			try {
				const settings = await invoke<{ templates_dir: string | null }>(
					"load_settings",
				);
				if (settings.templates_dir) {
					templateSchema = await invoke<VariableSchema>(
						"load_template_schema",
						{
							templatesDir: settings.templates_dir,
							templateRelPath,
						},
					);
				}
			} catch {
				// Schema is optional
			}

			pushNav(get());
			set({
				documentPath: docPath,
				templateRelPath,
				variables,
				variableValues,
				documentHtml,
				templateSchema,
				dirty: false,
				step: "edit-variables",
				loading: false,
			});
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to open document", err);
		}
	},

	renameDocument: async (newFilename) => {
		const { documentPath } = get();
		if (!documentPath) return;

		const oldFilename = extractFilename(documentPath);
		set({ loading: true, error: null });
		try {
			const newPath = await invoke<string>("rename_document", {
				docxPath: documentPath,
				newFilename,
			});
			set({ documentPath: newPath, loading: false });
			useUndoStore.getState().push({
				description: `Rename to ${newFilename}`,
				timestamp: Date.now(),
				redo: async () => {
					const { documentPath: dp } = get();
					if (!dp) return;
					const np = await invoke<string>("rename_document", {
						docxPath: dp,
						newFilename,
					});
					set({ documentPath: np });
				},
				undo: async () => {
					const { documentPath: dp } = get();
					if (!dp) return;
					const np = await invoke<string>("rename_document", {
						docxPath: dp,
						newFilename: oldFilename,
					});
					set({ documentPath: np });
				},
			});
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to rename document", err);
		}
	},

	saveDocument: async () => {
		const { documentPath, variableValues, workingDir, lilyFile } = get();
		if (!documentPath) return;

		set({ loading: true, error: null });
		try {
			await invoke("replace_variables", {
				docxPath: documentPath,
				variables: variableValues,
				conditionalDefinitions:
					lilyFile?.conditional_definitions ?? {},
			});

			const filename = extractFilename(documentPath);
			const docMeta = lilyFile?.documents[filename];
			if (docMeta?.role_overrides && workingDir) {
				for (const [role, override] of Object.entries(
					docMeta.role_overrides,
				)) {
					const updatedValues = { ...override.values };
					for (const varName of Object.keys(updatedValues)) {
						if (variableValues[varName] !== undefined) {
							updatedValues[varName] = variableValues[varName];
						}
					}
					await invoke("set_role_override", {
						workingDir,
						filename,
						role,
						overrideData: {
							contact_id: override.contact_id,
							values: updatedValues,
						},
					});
				}
			}

			if (workingDir) {
				const lilyFile = await invoke<LilyFile>(
					"load_lily_file_cmd",
					{ workingDir },
				);
				set({ lilyFile });
			}

			set({ loading: false, dirty: false });
			toastSuccess("Document saved");
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to save document", err);
		}
	},

	refreshPreview: async () => {
		const { documentPath } = get();
		if (!documentPath) return;

		try {
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: documentPath,
			});
			set({ documentHtml });
		} catch (err) {
			console.error("Failed to refresh preview:", err);
		}
	},

	deleteDocument: async (filename) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke("delete_document", { workingDir, filename });
			await get().reloadLilyFile();
		} catch (err) {
			console.error("Failed to delete document:", err);
			toastError("Failed to delete document", err);
		}
	},

	newVersionDocument: async (filename) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke<string>("new_version_document", {
				workingDir,
				filename,
			});
			await get().reloadLilyFile();
		} catch (err) {
			console.error("Failed to create new version:", err);
			toastError("Failed to create new version", err);
		}
	},

	openTemplateFile: async (templateRelPath) => {
		const settings = (await invoke("load_settings")) as {
			templates_dir: string | null;
		};
		if (!settings.templates_dir) return;

		const fullPath = `${settings.templates_dir}/${templateRelPath}`;
		try {
			await invoke("open_file_in_os", { filePath: fullPath });
		} catch (err) {
			console.error("Failed to open template file:", err);
			toastError("Failed to open template file", err);
		}
	},
});
