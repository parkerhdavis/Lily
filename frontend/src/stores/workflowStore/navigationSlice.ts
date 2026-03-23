import { useNavigationStore } from "@/stores/navigationStore";
import { useUndoStore } from "@/stores/undoStore";
import { pushNav } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createNavigationSlice: WorkflowSlice = (set, get) => ({
	setStep: (step) => {
		pushNav(get());
		set({ step });
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
});
