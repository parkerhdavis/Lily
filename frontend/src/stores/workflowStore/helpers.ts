import type { WorkflowStep, PersistedNavEntry } from "@/types";
import { useNavigationStore } from "@/stores/navigationStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { extractFolderName } from "@/utils/path";
import type { WorkflowState } from "./types";

const MAX_PERSISTED_HISTORY = 20;

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
		case "clients":
			return "Clients";
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
		case "template-editor":
			return "Pipeline \u203A Edit Template";
		default:
			return step;
	}
}

/** Push the current state to navigation history before navigating away. */
export function pushNav(state: WorkflowState) {
	const entry = {
		step: state.step,
		workingDir: state.workingDir,
		documentPath: state.documentPath,
		templateRelPath: state.templateRelPath,
		label: navLabel(state.step, state.workingDir),
	};
	useNavigationStore.getState().push(entry);
	debouncedPersistNavEntry(entry);
}

/**
 * Persist a navigation entry to settings for the "recent pages" list.
 * Deduplicates by (step, working_dir, document_path), keeps most recent,
 * excludes hub entries, caps at MAX_PERSISTED_HISTORY.
 */
function persistNavEntry(entry: {
	step: string;
	workingDir: string | null;
	documentPath: string | null;
	templateRelPath: string | null;
	label: string;
}) {
	if (entry.step === "hub") return;

	const settings = useSettingsStore.getState().settings;
	const newEntry: PersistedNavEntry = {
		step: entry.step,
		working_dir: entry.workingDir,
		document_path: entry.documentPath,
		template_rel_path: entry.templateRelPath,
		label: entry.label,
		visited_at: Date.now(),
	};

	// Deduplicate: remove existing entry with same composite key
	const key = (e: PersistedNavEntry) =>
		`${e.step}|${e.working_dir ?? ""}|${e.document_path ?? ""}`;
	const newKey = key(newEntry);
	const filtered = settings.navigation_history.filter(
		(e) => key(e) !== newKey,
	);

	const updated = [newEntry, ...filtered].slice(0, MAX_PERSISTED_HISTORY);
	useSettingsStore.getState().save({ navigation_history: updated });
}

/** Debounced version of persistNavEntry (500ms trailing edge). */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistNavEntry(entry: Parameters<typeof persistNavEntry>[0]) {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		persistNavEntry(entry);
	}, 500);
}
