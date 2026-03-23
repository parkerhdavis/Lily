import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
	WorkflowStep,
	LilyFile,
	VariableInfo,
	Contact,
	ContactBinding,
} from "@/types";
import {
	useNavigationStore,
	type NavigationEntry,
} from "@/stores/navigationStore";
import { useUndoStore } from "@/stores/undoStore";
import { extractFilename, extractFolderName } from "@/utils/path";
import { useToastStore } from "@/stores/toastStore";

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
	/** Clear a contact binding for a role (remove it entirely). */
	clearContactBinding: (role: string) => Promise<void>;
	/** Resolve all contact bindings into the variable pool. */
	resolveContactBindings: () => Promise<void>;
	/** Set or remove a per-document role override. */
	setRoleOverride: (
		role: string,
		overrideData: import("@/types").RoleOverride | null,
	) => Promise<void>;
	/** Save a questionnaire note for a section. */
	saveQuestionnaireNote: (
		section: string,
		noteKind: "client" | "internal",
		value: string,
	) => Promise<void>;
	/** Navigate to the interactive questionnaire view. */
	openQuestionnaire: () => void;
	/** Navigate to Add New Document (template selection). */
	startAddDocument: () => void;
	/** Return to the Client Hub, clearing document-specific state. */
	returnToHub: () => void;
	/** Navigate to the Lily Hub, preserving client state. */
	goToHub: () => void;
	/** Navigate to App Settings, preserving client state. */
	goToSettings: () => void;
	/** Navigate to Pipeline Management, preserving client state. */
	goToPipeline: () => void;
	/** Navigate to the Questionnaire Editor. */
	goToQuestionnaireEditor: () => void;
	/** Full reset: clear all client state and return to the Lily Hub. */
	reset: () => void;
	/** Restore state from a navigation history entry (back/forward).
	 *  Does NOT push to navigation history. */
	restoreNavigationEntry: (entry: NavigationEntry) => Promise<void>;
}

/** Show a toast error notification. */
function toastError(message: string, err?: unknown) {
	const detail = err ? `: ${String(err)}` : "";
	useToastStore.getState().addToast("error", `${message}${detail}`);
}

/** Show a toast success notification. */
function toastSuccess(message: string) {
	useToastStore.getState().addToast("success", message);
}

/** Build a human-readable label for a given step + context. */
function navLabel(
	step: WorkflowStep,
	workingDir: string | null,
): string {
	const folderName = workingDir ? extractFolderName(workingDir) : "";
	switch (step) {
		case "hub":
			return "Lily Hub";
		case "client-hub":
			return folderName || "Client Hub";
		case "questionnaire":
			return `${folderName} \u203A Questionnaire`;
		case "select-template":
			return `${folderName} \u203A Add Document`;
		case "edit-variables":
			return `${folderName} \u203A Edit Document`;
		case "app-settings":
			return "Settings";
		case "pipeline":
			return "Pipeline";
		case "questionnaire-editor":
			return "Pipeline \u203A Questionnaire Editor";
		default:
			return step;
	}
}

/** Push the current state to navigation history before navigating away. */
function pushNav(state: WorkflowState) {
	useNavigationStore.getState().push({
		step: state.step,
		workingDir: state.workingDir,
		documentPath: state.documentPath,
		templateRelPath: state.templateRelPath,
		label: navLabel(state.step, state.workingDir),
	});
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
	step: "hub",
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

	setStep: (step) => {
		pushNav(get());
		set({ step });
	},

	setWorkingDir: (dir) => {
		pushNav(get());
		set({ workingDir: dir, step: "client-hub" });

		// Load .lily file data for the selected working directory
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

			// Use the relative path's filename as the destination filename,
			// normalising .dotx templates to .docx since we produce documents.
			let filename = extractFilename(templateRelPath);
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

			pushNav(get());
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
			toastError("Failed to prepare document", err);
		}
	},

	updateVariable: (name, value) => {
		const { variableValues } = get();
		const oldValue = variableValues[name] ?? "";
		set({
			variableValues: { ...variableValues, [name]: value },
			dirty: true,
		});
		useUndoStore.getState().push({
			description: `Change ${name}`,
			timestamp: Date.now(),
			redo: () => {
				const s = get();
				set({
					variableValues: { ...s.variableValues, [name]: value },
					dirty: true,
				});
			},
			undo: () => {
				const s = get();
				set({
					variableValues: { ...s.variableValues, [name]: oldValue },
					dirty: true,
				});
			},
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

			// Apply per-document role overrides (override questionnaire values)
			const docMeta = lilyFile?.documents[filename];
			if (docMeta?.role_overrides) {
				for (const override of Object.values(docMeta.role_overrides)) {
					for (const [varName, value] of Object.entries(override.values)) {
						variableValues[varName] = value;
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
				conditionalDefinitions: lilyFile?.conditional_definitions ?? {},
			});

			// Update per-document role override values with current variableValues
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

	saveClientVariable: async (name, value) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldValue = get().lilyFile?.variables[name] ?? "";
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
			useUndoStore.getState().push({
				description: `Change client variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: value },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: value,
								},
							},
						});
					}
				},
				undo: async () => {
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: oldValue },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: oldValue,
								},
							},
						});
					}
				},
			});
		} catch (err) {
			console.error("Failed to save client variable:", err);
			toastError("Failed to save variable", err);
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
			useUndoStore.getState().push({
				description: `Add variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("add_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: { ...lf.variables, [name]: "" },
							},
						});
					}
				},
				undo: async () => {
					await invoke("remove_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						const { [name]: _, ...rest } = lf.variables;
						set({ lilyFile: { ...lf, variables: rest } });
					}
				},
			});
		} catch (err) {
			throw err;
		}
	},

	removeClientVariable: async (name) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldValue = get().lilyFile?.variables[name] ?? "";
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
			useUndoStore.getState().push({
				description: `Remove variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("remove_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						const { [name]: _, ...rest } = lf.variables;
						set({ lilyFile: { ...lf, variables: rest } });
					}
				},
				undo: async () => {
					await invoke("add_client_variable", {
						workingDir,
						variableName: name,
					});
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: oldValue },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: oldValue,
								},
							},
						});
					}
				},
			});
		} catch (err) {
			console.error("Failed to remove client variable:", err);
			toastError("Failed to remove variable", err);
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
		useUndoStore.getState().push({
			description: `Add contact ${contact.full_name}`,
			timestamp: Date.now(),
			redo: async () => {
				await invoke<Contact>("add_contact", {
					workingDir,
					contact: created,
				});
				await get().reloadLilyFile();
			},
			undo: async () => {
				await invoke("delete_contact", {
					workingDir,
					contactId: created.id,
				});
				await get().reloadLilyFile();
			},
		});
		return created;
	},

	updateContact: async (contact) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldContact = get().lilyFile?.contacts.find(
			(c) => c.id === contact.id,
		);
		await invoke("update_contact", { workingDir, contact });
		await get().reloadLilyFile();
		if (oldContact) {
			useUndoStore.getState().push({
				description: `Update contact ${contact.full_name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("update_contact", { workingDir, contact });
					await get().reloadLilyFile();
				},
				undo: async () => {
					await invoke("update_contact", {
						workingDir,
						contact: oldContact,
					});
					await get().reloadLilyFile();
				},
			});
		}
	},

	deleteContact: async (contactId) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldContact = get().lilyFile?.contacts.find(
			(c) => c.id === contactId,
		);
		await invoke("delete_contact", { workingDir, contactId });
		await get().reloadLilyFile();
		if (oldContact) {
			useUndoStore.getState().push({
				description: `Delete contact ${oldContact.full_name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("delete_contact", {
						workingDir,
						contactId,
					});
					await get().reloadLilyFile();
				},
				undo: async () => {
					await invoke<Contact>("add_contact", {
						workingDir,
						contact: oldContact,
					});
					await get().reloadLilyFile();
				},
			});
		}
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

		// Sync resolved values into variableValues for live preview
		const { lilyFile: updatedLily, variableValues } = get();
		if (updatedLily) {
			const merged = { ...variableValues };
			for (const varName of Object.keys(binding.variable_mappings)) {
				if (updatedLily.variables[varName] !== undefined) {
					merged[varName] = updatedLily.variables[varName];
				}
			}
			set({ variableValues: merged, dirty: true });
		}
	},

	clearContactBinding: async (role) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		const bindings = { ...(lilyFile?.contact_bindings ?? {}) };
		delete bindings[role];
		await invoke("save_contact_bindings", {
			workingDir,
			contactBindings: bindings,
		});
		await get().reloadLilyFile();
	},

	setRoleOverride: async (role, overrideData) => {
		const { workingDir, documentPath } = get();
		if (!workingDir || !documentPath) return;

		const filename = extractFilename(documentPath);
		await invoke("set_role_override", {
			workingDir,
			filename,
			role,
			overrideData,
		});
		await get().reloadLilyFile();
	},

	resolveContactBindings: async () => {
		const { workingDir } = get();
		if (!workingDir) return;

		await invoke("resolve_contact_variables", { workingDir });
		await get().reloadLilyFile();
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
		// Update local state without full reload
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

	openQuestionnaire: () => {
		pushNav(get());
		set({ step: "questionnaire" });
	},

	startAddDocument: () => {
		pushNav(get());
		set({ step: "select-template" });
	},

	returnToHub: () => {
		pushNav(get());
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

	goToHub: () => {
		pushNav(get());
		set({ step: "hub" });
	},
	goToSettings: () => {
		pushNav(get());
		set({ step: "app-settings" });
	},
	goToPipeline: () => {
		pushNav(get());
		set({ step: "pipeline" });
	},
	goToQuestionnaireEditor: () => {
		pushNav(get());
		set({ step: "questionnaire-editor" });
	},

	reset: () => {
		useNavigationStore.getState().clear();
		useUndoStore.getState().clear();
		set({
			step: "hub",
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

		// Reload .lily file if we changed working directories
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

		// Reload document HTML if restoring to a document editing step
		if (needsDocReload && entry.step === "edit-variables") {
			try {
				const documentHtml = await invoke<string>("get_document_html", {
					docxPath: entry.documentPath,
				});
				// Re-extract variables
				let variables = await invoke<VariableInfo[]>(
					"extract_variables",
					{ docxPath: entry.documentPath },
				);
				const { lilyFile } = get();
				// Patch conditionals from .lily
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
				// Fall back to stored variable names if no placeholders remain
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
				// Restore variable values from client pool
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
}));
