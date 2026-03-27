import { invoke } from "@tauri-apps/api/core";
import type { LilyFile, VariableInfo, VariableSchema } from "@/types";
import { useUndoStore } from "@/stores/undoStore";
import { extractFilename } from "@/utils/path";
import { buildDocumentFilename, mergeStoredVariables, pushNav, toastError, toastSuccess } from "./helpers";
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

			const filename = buildDocumentFilename(templateRelPath, lilyFile);

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

			// Resolve contact variables so that any new relationship-based
			// conditionals (e.g. "Has Spouse") pick up values immediately.
			await invoke("resolve_contact_variables", { workingDir });

			const updatedLilyFile = await invoke<LilyFile>(
				"load_lily_file_cmd",
				{ workingDir },
			);

			// Build variableValues from the updated .lily file so
			// contact-resolved values are included
			const mergedVars = updatedLilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				const defaultVal = v.is_conditional ? "false" : "";
				variableValues[v.display_name] =
					mergedVars[v.display_name] ?? defaultVal;
			}

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

			// Write variable values into the .docx immediately so the
			// document is populated from the start (not just on manual save)
			await invoke("replace_variables", {
				docxPath: docPath,
				variables: variableValues,
				conditionalDefinitions:
					updatedLilyFile?.conditional_definitions ?? {},
			});

			// Refresh preview to reflect populated values
			let documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

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

	addMultipleDocuments: async (templateRelPaths, templatesDir) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		set({ loading: true, error: null });
		try {
			// Track used filenames to avoid collisions within the batch
			const usedFilenames = new Set<string>(
				Object.keys(lilyFile?.documents ?? {}),
			);
			const addedDocPaths: string[] = [];

			for (const templateRelPath of templateRelPaths) {
				const fullTemplatePath = `${templatesDir}/${templateRelPath}`;
				let filename = buildDocumentFilename(
					templateRelPath,
					lilyFile,
				);

				// De-duplicate filename
				let candidate = filename;
				let counter = 2;
				while (usedFilenames.has(candidate)) {
					const base = filename.replace(/\.docx$/i, "");
					candidate = `${base} (${counter}).docx`;
					counter++;
				}
				filename = candidate;
				usedFilenames.add(filename);

				const docPath = await invoke<string>("copy_template", {
					templatePath: fullTemplatePath,
					destDir: workingDir,
					filename,
					templateRelPath,
				});
				addedDocPaths.push(docPath);

				const variables = await invoke<VariableInfo[]>(
					"extract_variables",
					{ docxPath: docPath },
				);

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
			}

			// Resolve contact variables so new relationship-based
			// conditionals pick up values immediately.
			await invoke("resolve_contact_variables", { workingDir });

			// Reload once at the end
			const updatedLilyFile = await invoke<LilyFile>(
				"load_lily_file_cmd",
				{ workingDir },
			);

			// Populate each added document with variable values from
			// the questionnaire so they're saved into the .docx immediately
			const allVars = updatedLilyFile?.variables ?? {};
			const allCondDefs =
				updatedLilyFile?.conditional_definitions ?? {};
			for (const docPath of addedDocPaths) {
				await invoke("replace_variables", {
					docxPath: docPath,
					variables: allVars,
					conditionalDefinitions: allCondDefs,
				});
			}

			pushNav(get());
			set({
				lilyFile: updatedLilyFile,
				step: "clients",
				loading: false,
			});
			toastSuccess(
				`Added ${templateRelPaths.length} document${templateRelPaths.length !== 1 ? "s" : ""}`,
			);
		} catch (err) {
			set({ error: String(err), loading: false });
			toastError("Failed to add documents", err);
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

			// Merge with stored names to restore nested variables inside
			// false conditionals, preserving document order and contact-role variants.
			variables = mergeStoredVariables(variables, filename, lilyFile);

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
			// Apply per-document variable overrides
			if (docMeta?.variable_overrides) {
				for (const [varName, value] of Object.entries(
					docMeta.variable_overrides,
				)) {
					variableValues[varName] = value;
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
