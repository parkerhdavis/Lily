import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
	QuestionnaireDefFile,
	QuestionnaireIndex,
} from "@/types/questionnaire";
import { useToastStore } from "@/stores/toastStore";

interface QuestionnaireState {
	index: QuestionnaireIndex | null;
	/** The currently-loaded questionnaire definition (for editing or viewing). */
	currentDef: QuestionnaireDefFile | null;
	loading: boolean;
	error: string | null;

	loadIndex: () => Promise<void>;
	loadQuestionnaire: (id: string) => Promise<void>;
	saveQuestionnaire: (def: QuestionnaireDefFile) => Promise<void>;
	createQuestionnaire: (name: string) => Promise<QuestionnaireDefFile>;
	duplicateQuestionnaire: (
		id: string,
		name: string,
	) => Promise<QuestionnaireDefFile>;
	deleteQuestionnaire: (id: string) => Promise<void>;
	setActiveQuestionnaire: (id: string) => Promise<void>;
	/** Get the active questionnaire definition for use by the client questionnaire view. */
	loadActiveQuestionnaire: () => Promise<QuestionnaireDefFile | null>;
}

export const useQuestionnaireStore = create<QuestionnaireState>((set, get) => ({
	index: null,
	currentDef: null,
	loading: false,
	error: null,

	loadIndex: async () => {
		set({ loading: true, error: null });
		try {
			const index =
				await invoke<QuestionnaireIndex>("load_questionnaire_index");
			set({ index, loading: false });
		} catch (err) {
			set({ error: String(err), loading: false });
			useToastStore.getState().addToast("error", "Failed to load questionnaire index");
		}
	},

	loadQuestionnaire: async (id) => {
		set({ loading: true, error: null });
		try {
			const def = await invoke<QuestionnaireDefFile>(
				"load_questionnaire",
				{ id },
			);
			set({ currentDef: def, loading: false });
		} catch (err) {
			set({ error: String(err), loading: false });
			useToastStore.getState().addToast("error", "Failed to load questionnaire");
		}
	},

	saveQuestionnaire: async (def) => {
		set({ loading: true, error: null });
		try {
			await invoke("save_questionnaire", { questionnaire: def });
			// Reload to get the bumped version
			const updated = await invoke<QuestionnaireDefFile>(
				"load_questionnaire",
				{ id: def.id },
			);
			set({ currentDef: updated, loading: false });
			// Refresh the index
			const index =
				await invoke<QuestionnaireIndex>("load_questionnaire_index");
			set({ index });
		} catch (err) {
			set({ error: String(err), loading: false });
			useToastStore.getState().addToast("error", "Failed to save questionnaire");
		}
	},

	createQuestionnaire: async (name) => {
		const def = await invoke<QuestionnaireDefFile>(
			"create_questionnaire",
			{ name },
		);
		// Refresh index
		const index =
			await invoke<QuestionnaireIndex>("load_questionnaire_index");
		set({ index, currentDef: def });
		return def;
	},

	duplicateQuestionnaire: async (id, name) => {
		const def = await invoke<QuestionnaireDefFile>(
			"duplicate_questionnaire",
			{ id, name },
		);
		const index =
			await invoke<QuestionnaireIndex>("load_questionnaire_index");
		set({ index, currentDef: def });
		return def;
	},

	deleteQuestionnaire: async (id) => {
		await invoke("delete_questionnaire", { id });
		const { currentDef } = get();
		if (currentDef?.id === id) {
			set({ currentDef: null });
		}
		const index =
			await invoke<QuestionnaireIndex>("load_questionnaire_index");
		set({ index });
	},

	setActiveQuestionnaire: async (id) => {
		await invoke("set_active_questionnaire", { id });
		const index =
			await invoke<QuestionnaireIndex>("load_questionnaire_index");
		set({ index });
	},

	loadActiveQuestionnaire: async () => {
		// Ensure index is loaded
		let { index } = get();
		if (!index) {
			index = await invoke<QuestionnaireIndex>(
				"load_questionnaire_index",
			);
			set({ index });
		}
		const activeId = index.active_questionnaire_id;
		if (!activeId) return null;
		try {
			return await invoke<QuestionnaireDefFile>("load_questionnaire", {
				id: activeId,
			});
		} catch {
			return null;
		}
	},
}));
