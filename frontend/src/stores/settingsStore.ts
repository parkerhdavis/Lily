import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types";

const MAX_RECENT_DIRECTORIES = 10;

interface SettingsState {
	settings: AppSettings;
	loaded: boolean;
	load: () => Promise<void>;
	save: (settings: Partial<AppSettings>) => Promise<void>;
	addRecentDirectory: (dir: string) => Promise<void>;
	removeRecentDirectory: (dir: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	settings: {
		templates_dir: null,
		last_working_dir: null,
		recent_directories: [],
		window_width: null,
		window_height: null,
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

	addRecentDirectory: async (dir) => {
		const current = get().settings;
		const filtered = current.recent_directories.filter((d) => d !== dir);
		const recent = [dir, ...filtered].slice(0, MAX_RECENT_DIRECTORIES);
		await get().save({ recent_directories: recent });
	},

	removeRecentDirectory: async (dir) => {
		const current = get().settings;
		const filtered = current.recent_directories.filter((d) => d !== dir);
		await get().save({ recent_directories: filtered });
	},
}));
