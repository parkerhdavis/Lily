import { create } from "zustand";
import { createContactSlice } from "./workflowStore/contactSlice";
import { createDocumentSlice } from "./workflowStore/documentSlice";
import { createNavigationSlice } from "./workflowStore/navigationSlice";
import { createProjectSlice } from "./workflowStore/projectSlice";
import { createTemplateEditorSlice } from "./workflowStore/templateEditorSlice";
import type { WorkflowState } from "./workflowStore/types";
import { createVariableSlice } from "./workflowStore/variableSlice";

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
		templateSchema: null,
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
