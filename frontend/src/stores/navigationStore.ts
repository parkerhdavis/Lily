import { create } from "zustand";
import type { WorkflowStep } from "@/types";

const MAX_HISTORY = 50;

export interface NavigationEntry {
	step: WorkflowStep;
	workingDir: string | null;
	documentPath: string | null;
	templateRelPath: string | null;
	label: string;
}

interface NavigationState {
	history: NavigationEntry[];
	currentIndex: number;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Push a new entry, truncating any forward history. */
	push: (entry: NavigationEntry) => void;
	/** Go back one step. Returns the entry to navigate to, or null. */
	goBack: () => NavigationEntry | null;
	/** Go forward one step. Returns the entry to navigate to, or null. */
	goForward: () => NavigationEntry | null;
	/** Get the current entry. */
	current: () => NavigationEntry | null;
	/** Clear all history. */
	clear: () => void;
}

function computeFlags(history: NavigationEntry[], currentIndex: number) {
	return {
		canGoBack: currentIndex > 0,
		canGoForward: currentIndex < history.length - 1,
	};
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
	history: [],
	currentIndex: -1,
	canGoBack: false,
	canGoForward: false,

	push: (entry) => {
		const { history, currentIndex } = get();
		// Truncate forward history
		const trimmed = history.slice(0, currentIndex + 1);
		const updated = [...trimmed, entry];
		// Cap at max
		const start = Math.max(0, updated.length - MAX_HISTORY);
		const capped = updated.slice(start);
		const newIndex = capped.length - 1;
		set({
			history: capped,
			currentIndex: newIndex,
			...computeFlags(capped, newIndex),
		});
	},

	goBack: () => {
		const { history, currentIndex } = get();
		if (currentIndex <= 0) return null;
		const newIndex = currentIndex - 1;
		set({
			currentIndex: newIndex,
			...computeFlags(history, newIndex),
		});
		return history[newIndex];
	},

	goForward: () => {
		const { history, currentIndex } = get();
		if (currentIndex >= history.length - 1) return null;
		const newIndex = currentIndex + 1;
		set({
			currentIndex: newIndex,
			...computeFlags(history, newIndex),
		});
		return history[newIndex];
	},

	current: () => {
		const { history, currentIndex } = get();
		return currentIndex >= 0 ? history[currentIndex] : null;
	},

	clear: () =>
		set({
			history: [],
			currentIndex: -1,
			canGoBack: false,
			canGoForward: false,
		}),
}));
