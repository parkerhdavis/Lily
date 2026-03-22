import { useSettingsStore } from "@/stores/settingsStore";

/** Returns the correct Lily icon path for the current theme. */
export function useLilyIcon(): string {
	const theme = useSettingsStore((s) => s.settings.theme);
	return theme === "dark" ? "/lily-icon-trans-inv.png" : "/lily-icon-trans.png";
}
