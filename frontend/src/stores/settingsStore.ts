import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types";

interface SettingsState {
	settings: AppSettings;
	loaded: boolean;
	load: () => Promise<void>;
	save: (settings: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	settings: {
		templates_dir: null,
		last_working_dir: null,
	},
	loaded: false,

	load: async () => {
		try {
			const settings = await invoke<AppSettings>("load_settings");
			set({ settings, loaded: true });
		} catch (err) {
			console.error("Failed to load settings:", err);
			set({ loaded: true });
		}
	},

	save: async (partial) => {
		const current = get().settings;
		const updated = { ...current, ...partial };
		try {
			await invoke("save_settings", { settings: updated });
			set({ settings: updated });
		} catch (err) {
			console.error("Failed to save settings:", err);
		}
	},
}));
