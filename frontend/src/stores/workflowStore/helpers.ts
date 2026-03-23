import type { WorkflowStep } from "@/types";
import { useNavigationStore } from "@/stores/navigationStore";
import { useToastStore } from "@/stores/toastStore";
import { extractFolderName } from "@/utils/path";
import type { WorkflowState } from "./types";

/** Show a toast error notification. */
export function toastError(message: string, err?: unknown) {
	const detail = err ? `: ${String(err)}` : "";
	useToastStore.getState().addToast("error", `${message}${detail}`);
}

/** Show a toast success notification. */
export function toastSuccess(message: string) {
	useToastStore.getState().addToast("success", message);
}

/** Build a human-readable label for a given step + context. */
export function navLabel(
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
export function pushNav(state: WorkflowState) {
	useNavigationStore.getState().push({
		step: state.step,
		workingDir: state.workingDir,
		documentPath: state.documentPath,
		templateRelPath: state.templateRelPath,
		label: navLabel(state.step, state.workingDir),
	});
}
