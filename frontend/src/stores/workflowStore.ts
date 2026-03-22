import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
	WorkflowStep,
	LilyFile,
	VariableInfo,
	Contact,
	ContactBinding,
} from "@/types";

interface WorkflowState {
	step: WorkflowStep;
	workingDir: string | null;
	documentPath: string | null;
	documentHtml: string;
	/** Variable info with display names and case variants. */
	variables: VariableInfo[];
	/** Variable values keyed by display_name. */
	variableValues: Record<string, string>;
	templates: string[];
	/** The relative path of the selected template within the templates dir. */
	templateRelPath: string | null;
	/** .lily project file data for the current working directory. */
	lilyFile: LilyFile | null;
	/** Whether the document has unsaved changes. */
	dirty: boolean;
	loading: boolean;
	error: string | null;

	setStep: (step: WorkflowStep) => void;
	setWorkingDir: (dir: string) => void;
	loadTemplates: (templatesDir: string) => Promise<void>;
	selectTemplate: (
		templateRelPath: string,
		templatesDir: string,
	) => Promise<void>;
	updateVariable: (name: string, value: string) => void;
	/** Open an existing document from the working directory. */
	openDocument: (filename: string, templateRelPath: string) => Promise<void>;
	renameDocument: (newFilename: string) => Promise<void>;
	saveDocument: () => Promise<void>;
	refreshPreview: () => Promise<void>;
	/** Save a single client variable (auto-save on blur from the Client Hub). */
	saveClientVariable: (name: string, value: string) => Promise<void>;
	/** Add a new variable to the client-level pool. */
	addClientVariable: (name: string) => Promise<void>;
	/** Remove a variable from the client-level pool. */
	removeClientVariable: (name: string) => Promise<void>;
	/** Delete a document from disk and the .lily file. */
	deleteDocument: (filename: string) => Promise<void>;
	/** Create a new versioned copy of an existing document. */
	newVersionDocument: (filename: string) => Promise<void>;
	/** Open a template file in the OS default application. */
	openTemplateFile: (templateRelPath: string) => Promise<void>;
	/** Reload the .lily file from disk into the store. */
	reloadLilyFile: () => Promise<void>;
	/** Add a new contact to the client's .lily file. */
	addContact: (contact: Omit<Contact, "id">) => Promise<Contact>;
	/** Update an existing contact. */
	updateContact: (contact: Contact) => Promise<void>;
	/** Delete a contact by ID. */
	deleteContact: (contactId: string) => Promise<void>;
	/** Set or clear a contact binding for a role. */
	setContactBinding: (
		role: string,
		binding: ContactBinding,
	) => Promise<void>;
	/** Resolve all contact bindings into the variable pool. */
	resolveContactBindings: () => Promise<void>;
	/** Navigate to the interactive questionnaire view. */
	openQuestionnaire: () => void;
	/** Navigate to Add New Document (template selection). */
	startAddDocument: () => void;
	/** Return to the Client Hub, clearing document-specific state. */
	returnToHub: () => void;
	reset: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
	step: "select-directory",
	workingDir: null,
	documentPath: null,
	documentHtml: "",
	variables: [],
	variableValues: {},
	templates: [],
	templateRelPath: null,
	lilyFile: null,
	dirty: false,
	loading: false,
	error: null,

	setStep: (step) => set({ step }),

	setWorkingDir: (dir) => {
		set({ workingDir: dir, step: "client-hub" });

		// Load .lily file data for the selected working directory
		invoke<LilyFile>("load_lily_file_cmd", { workingDir: dir })
			.then((lilyFile) => set({ lilyFile }))
			.catch((err) =>
				console.error("Failed to load .lily file:", err),
			);
	},

	loadTemplates: async (templatesDir) => {
		set({ loading: true, error: null });
		try {
			const templates = await invoke<string[]>("list_templates", {
				templatesDir,
			});
			set({ templates, loading: false });
		} catch (err) {
			set({ error: String(err), loading: false });
		}
	},

	selectTemplate: async (templateRelPath, templatesDir) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		set({ loading: true, error: null });
		try {
			const fullTemplatePath = `${templatesDir}/${templateRelPath}`;

			// Use the relative path's filename as the destination filename,
			// normalising .dotx templates to .docx since we produce documents.
			let filename = templateRelPath.split("/").pop() || templateRelPath;
			if (filename.toLowerCase().endsWith(".dotx")) {
				filename = filename.slice(0, -5) + ".docx";
			}

			const docPath = await invoke<string>("copy_template", {
				templatePath: fullTemplatePath,
				destDir: workingDir,
				filename,
				templateRelPath,
			});

			// Extract variables from the copied document
			const variables = await invoke<VariableInfo[]>("extract_variables", {
				docxPath: docPath,
			});

			// Get HTML preview
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			// Initialize variable values from the client-level .lily file pool
			const savedVars = lilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				const defaultVal = v.is_conditional ? "false" : "";
				variableValues[v.display_name] =
					savedVars[v.display_name] ?? defaultVal;
			}

			// Build conditional definitions map from the extracted variables.
			// Each conditional variable may have multiple variants (different
			// true/false text) and we store them all keyed by display name.
			const conditionalDefs: Record<string, string[]> = {};
			for (const v of variables) {
				if (v.is_conditional) {
					conditionalDefs[v.display_name] = v.variants;
				}
			}

			// Store the variable names in the .lily document metadata so they
			// survive across save cycles (where placeholders get replaced)
			await invoke("set_document_variables", {
				workingDir,
				filename,
				variableNames: variables.map((v) => v.display_name),
				conditionalNames: variables
					.filter((v) => v.is_conditional)
					.map((v) => v.display_name),
				conditionalDefinitions: conditionalDefs,
			});

			// Reload .lily file to pick up the new document entry
			const updatedLilyFile = await invoke<LilyFile>(
				"load_lily_file_cmd",
				{ workingDir },
			);

			set({
				documentPath: docPath,
				templateRelPath,
				variables,
				variableValues,
				documentHtml,
				lilyFile: updatedLilyFile,
				dirty: false,
				step: "edit-variables",
				loading: false,
			});
		} catch (err) {
			set({ error: String(err), loading: false });
		}
	},

	updateVariable: (name, value) => {
		const { variableValues } = get();
		set({
			variableValues: { ...variableValues, [name]: value },
			dirty: true,
		});
	},

	openDocument: async (filename, templateRelPath) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		set({ loading: true, error: null });
		try {
			const docPath = `${workingDir}/${filename}`;

			// Extract variables from the existing document
			let variables = await invoke<VariableInfo[]>("extract_variables", {
				docxPath: docPath,
			});

			// If no variables were found in the docx (placeholders have been
			// replaced with real values on a previous save), fall back to the
			// stored variable_names list in the .lily document metadata.
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

			// After the first save, SDTs and bookmarks no longer carry the
			// `??` conditional syntax, so extract_variables reports them as
			// non-conditional. Patch is_conditional using the authoritative
			// list stored in the .lily file.
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

			// Get HTML preview
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			// Restore variable values from the client-level .lily file pool
			const savedVars = lilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				const defaultVal = v.is_conditional ? "false" : "";
				variableValues[v.display_name] =
					savedVars[v.display_name] ?? defaultVal;
			}

			set({
				documentPath: docPath,
				templateRelPath,
				variables,
				variableValues,
				documentHtml,
				dirty: false,
				step: "edit-variables",
				loading: false,
			});
		} catch (err) {
			set({ error: String(err), loading: false });
		}
	},

	renameDocument: async (newFilename) => {
		const { documentPath } = get();
		if (!documentPath) return;

		set({ loading: true, error: null });
		try {
			const newPath = await invoke<string>("rename_document", {
				docxPath: documentPath,
				newFilename,
			});
			set({ documentPath: newPath, loading: false });
		} catch (err) {
			set({ error: String(err), loading: false });
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
				conditionalDefinitions: lilyFile?.conditional_definitions ?? {},
			});

			// Reload .lily file to reflect updated variable values and timestamp
			if (workingDir) {
				const lilyFile = await invoke<LilyFile>("load_lily_file_cmd", {
					workingDir,
				});
				set({ lilyFile });
			}

			// Don't refresh documentHtml — the live preview depends on the
			// original placeholder spans remaining in the HTML so the
			// client-side replacement continues to work after save.
			set({ loading: false, dirty: false });
		} catch (err) {
			set({ error: String(err), loading: false });
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

	saveClientVariable: async (name, value) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke("save_client_variables", {
				workingDir,
				variableValues: { [name]: value },
			});
			// Update the local lilyFile state to reflect the change
			const { lilyFile } = get();
			if (lilyFile) {
				set({
					lilyFile: {
						...lilyFile,
						variables: { ...lilyFile.variables, [name]: value },
					},
				});
			}
		} catch (err) {
			console.error("Failed to save client variable:", err);
		}
	},

	addClientVariable: async (name) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke("add_client_variable", {
				workingDir,
				variableName: name,
			});
			// Update local state
			const { lilyFile } = get();
			if (lilyFile) {
				set({
					lilyFile: {
						...lilyFile,
						variables: { ...lilyFile.variables, [name]: "" },
					},
				});
			}
		} catch (err) {
			throw err;
		}
	},

	removeClientVariable: async (name) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke("remove_client_variable", {
				workingDir,
				variableName: name,
			});
			// Update local state
			const { lilyFile } = get();
			if (lilyFile) {
				const { [name]: _, ...rest } = lilyFile.variables;
				set({
					lilyFile: {
						...lilyFile,
						variables: rest,
					},
				});
			}
		} catch (err) {
			console.error("Failed to remove client variable:", err);
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
		}
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

	addContact: async (contact) => {
		const { workingDir } = get();
		if (!workingDir) throw new Error("No working directory");

		const created = await invoke<Contact>("add_contact", {
			workingDir,
			contact: { id: "", ...contact },
		});
		await get().reloadLilyFile();
		return created;
	},

	updateContact: async (contact) => {
		const { workingDir } = get();
		if (!workingDir) return;

		await invoke("update_contact", { workingDir, contact });
		await get().reloadLilyFile();
	},

	deleteContact: async (contactId) => {
		const { workingDir } = get();
		if (!workingDir) return;

		await invoke("delete_contact", { workingDir, contactId });
		await get().reloadLilyFile();
	},

	setContactBinding: async (role, binding) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		const bindings = { ...(lilyFile?.contact_bindings ?? {}) };
		bindings[role] = binding;
		await invoke("save_contact_bindings", {
			workingDir,
			contactBindings: bindings,
		});
		// Resolve the binding into the variables pool
		await invoke("resolve_contact_variables", { workingDir });
		await get().reloadLilyFile();
	},

	resolveContactBindings: async () => {
		const { workingDir } = get();
		if (!workingDir) return;

		await invoke("resolve_contact_variables", { workingDir });
		await get().reloadLilyFile();
	},

	openQuestionnaire: () => {
		set({ step: "questionnaire" });
	},

	startAddDocument: () => {
		set({ step: "select-template" });
	},

	returnToHub: () => {
		// Clear document-specific state but keep workingDir, lilyFile, templates
		set({
			step: "client-hub",
			documentPath: null,
			documentHtml: "",
			variables: [],
			variableValues: {},
			templateRelPath: null,
			dirty: false,
			error: null,
		});
		// Reload .lily file to pick up any changes made while editing
		get().reloadLilyFile();
	},

	reset: () =>
		set({
			step: "select-directory",
			workingDir: null,
			documentPath: null,
			documentHtml: "",
			variables: [],
			variableValues: {},
			templates: [],
			templateRelPath: null,
			lilyFile: null,
			dirty: false,
			error: null,
		}),
}));
