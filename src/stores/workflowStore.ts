import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WorkflowStep, SidecarFile } from "@/types";

interface WorkflowState {
	step: WorkflowStep;
	workingDir: string | null;
	documentPath: string | null;
	documentHtml: string;
	variables: string[];
	variableValues: Record<string, string>;
	templates: string[];
	/** The relative path of the selected template within the templates dir. */
	templateRelPath: string | null;
	/** Sidecar data for the current working directory. */
	sidecar: SidecarFile | null;
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
	sidecar: null,
	dirty: false,
	loading: false,
	error: null,

	setStep: (step) => set({ step }),

	setWorkingDir: (dir) => {
		// Load sidecar data for the selected working directory
		invoke<SidecarFile>("load_sidecar", { workingDir: dir })
			.then((sidecar) => set({ sidecar }))
			.catch((err) => console.error("Failed to load sidecar:", err));

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
		const { workingDir } = get();
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
			const variables = await invoke<string[]>("extract_variables", {
				docxPath: docPath,
			});

			// Get HTML preview
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: docPath,
			});

			// Initialize variable values
			const variableValues: Record<string, string> = {};
			for (const v of variables) {
				variableValues[v] = "";
			}

			// Reload sidecar to pick up the new document entry
			const sidecar = await invoke<SidecarFile>("load_sidecar", {
				workingDir,
			});

			set({
				documentPath: docPath,
				templateRelPath,
				variables,
				variableValues,
				documentHtml,
				sidecar,
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

			// Reload sidecar to reflect updated variable values and timestamp
			if (workingDir) {
				const sidecar = await invoke<SidecarFile>("load_sidecar", {
					workingDir,
				});
				set({ sidecar });
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
			sidecar: null,
			dirty: false,
			error: null,
		}),
}));
