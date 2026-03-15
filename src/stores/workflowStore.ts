import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WorkflowStep } from "@/types";

interface WorkflowState {
	step: WorkflowStep;
	workingDir: string | null;
	documentPath: string | null;
	documentHtml: string;
	variables: string[];
	variableValues: Record<string, string>;
	templates: string[];
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
	loading: false,
	error: null,

	setStep: (step) => set({ step }),

	setWorkingDir: (dir) => set({ workingDir: dir, step: "select-template" }),

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

			set({
				documentPath: docPath,
				variables,
				variableValues,
				documentHtml,
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
		});
	},

	saveDocument: async () => {
		const { documentPath, variableValues } = get();
		if (!documentPath) return;

		set({ loading: true, error: null });
		try {
			await invoke("replace_variables", {
				docxPath: documentPath,
				variables: variableValues,
			});

			// Refresh preview after save
			const documentHtml = await invoke<string>("get_document_html", {
				docxPath: documentPath,
			});
			set({ documentHtml, loading: false });
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
			error: null,
		}),
}));
