import { create } from "zustand";

const MAX_UNDO = 100;
/** Time window (ms) for coalescing consecutive changes to the same field. */
const COALESCE_MS = 500;

export interface UndoableAction {
	description: string;
	timestamp: number;
	redo: () => void | Promise<void>;
	undo: () => void | Promise<void>;
}

interface UndoState {
	undoStack: UndoableAction[];
	redoStack: UndoableAction[];
	canUndo: boolean;
	canRedo: boolean;
	/** True while an undo or redo operation is in progress. */
	busy: boolean;
	/** Push a new undoable action. Clears the redo stack. */
	push: (action: UndoableAction) => void;
	/** Undo the most recent action. */
	undo: () => Promise<void>;
	/** Redo the most recently undone action. */
	redo: () => Promise<void>;
	/** Clear both stacks. */
	clear: () => void;
}

export const useUndoStore = create<UndoState>((set, get) => ({
	undoStack: [],
	redoStack: [],
	canUndo: false,
	canRedo: false,
	busy: false,

	push: (action) => {
		const { undoStack } = get();

		// Coalesce: if the top action has the same description and is recent,
		// replace it (keep the original undo, use the new redo).
		const top = undoStack[undoStack.length - 1];
		if (
			top &&
			top.description === action.description &&
			action.timestamp - top.timestamp < COALESCE_MS
		) {
			const coalesced: UndoableAction = {
				description: action.description,
				timestamp: action.timestamp,
				redo: action.redo,
				undo: top.undo, // preserve the original "before" state
			};
			const updated = [...undoStack.slice(0, -1), coalesced];
			set({
				undoStack: updated,
				redoStack: [],
				canUndo: updated.length > 0,
				canRedo: false,
			});
			return;
		}

		const updated = [...undoStack, action];
		const capped =
			updated.length > MAX_UNDO
				? updated.slice(updated.length - MAX_UNDO)
				: updated;
		set({
			undoStack: capped,
			redoStack: [],
			canUndo: capped.length > 0,
			canRedo: false,
		});
	},

	undo: async () => {
		const { undoStack, redoStack, busy } = get();
		if (undoStack.length === 0 || busy) return;

		const action = undoStack[undoStack.length - 1];
		const newUndo = undoStack.slice(0, -1);

		set({ busy: true });
		try {
			await action.undo();
		} catch (err) {
			console.error("Undo failed:", err);
			set({ busy: false });
			return;
		}

		const newRedo = [...redoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: newUndo.length > 0,
			canRedo: true,
			busy: false,
		});
	},

	redo: async () => {
		const { undoStack, redoStack, busy } = get();
		if (redoStack.length === 0 || busy) return;

		const action = redoStack[redoStack.length - 1];
		const newRedo = redoStack.slice(0, -1);

		set({ busy: true });
		try {
			await action.redo();
		} catch (err) {
			console.error("Redo failed:", err);
			set({ busy: false });
			return;
		}

		const newUndo = [...undoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: true,
			canRedo: newRedo.length > 0,
			busy: false,
		});
	},

	clear: () =>
		set({
			undoStack: [],
			redoStack: [],
			canUndo: false,
			canRedo: false,
		}),
}));
