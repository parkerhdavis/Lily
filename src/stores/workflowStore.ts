import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WorkflowStep, LilyFile, VariableInfo } from "@/types";

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
		// Load .lily file data for the selected working directory
		invoke<LilyFile>("load_lily_file_cmd", { workingDir: dir })
			.then((lilyFile) => set({ lilyFile }))
			.catch((err) => console.error("Failed to load .lily file:", err));

		set({ workingDir: dir, step: "select-template" });
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

			// Use the relative path's filename as the destination filename
			const filename = templateRelPath.split("/").pop() || templateRelPath;

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
				variableValues[v.display_name] = savedVars[v.display_name] ?? "";
			}

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
			const variables = await invoke<VariableInfo[]>("extract_variables", {
				docxPath: docPath,
			});

			// Get HTML preview
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			// Restore variable values from the client-level .lily file pool
			const savedVars = lilyFile?.variables ?? {};
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				variableValues[v.display_name] = savedVars[v.display_name] ?? "";
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
		const { documentPath, variableValues, workingDir } = get();
		if (!documentPath) return;

		set({ loading: true, error: null });
		try {
			await invoke("replace_variables", {
				docxPath: documentPath,
				variables: variableValues,
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
