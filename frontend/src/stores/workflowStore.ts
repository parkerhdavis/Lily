import { create } from "zustand";
import type { WorkflowState } from "./workflowStore/types";
import { createNavigationSlice } from "./workflowStore/navigationSlice";
import { createDocumentSlice } from "./workflowStore/documentSlice";
import { createVariableSlice } from "./workflowStore/variableSlice";
import { createContactSlice } from "./workflowStore/contactSlice";
import { createProjectSlice } from "./workflowStore/projectSlice";
import { createTemplateEditorSlice } from "./workflowStore/templateEditorSlice";

export type { WorkflowState } from "./workflowStore/types";

export const useWorkflowStore = create<WorkflowState>((...a) => {
	const [set, get] = a;
	return {
		// Initial state
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

		// Compose slices — each provides a subset of actions
		...createNavigationSlice(set, get),
		...createDocumentSlice(set, get),
		...createVariableSlice(set, get),
		...createContactSlice(set, get),
		...createProjectSlice(set, get),
		...createTemplateEditorSlice(set, get),
	} as WorkflowState;
});
