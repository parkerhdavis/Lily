import { create } from "zustand";

const MAX_UNDO = 100;

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

	push: (action) => {
		const { undoStack } = get();
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
		const { undoStack, redoStack } = get();
		if (undoStack.length === 0) return;

		const action = undoStack[undoStack.length - 1];
		const newUndo = undoStack.slice(0, -1);

		try {
			await action.undo();
		} catch (err) {
			console.error("Undo failed:", err);
			return;
		}

		const newRedo = [...redoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: newUndo.length > 0,
			canRedo: true,
		});
	},

	redo: async () => {
		const { undoStack, redoStack } = get();
		if (redoStack.length === 0) return;

		const action = redoStack[redoStack.length - 1];
		const newRedo = redoStack.slice(0, -1);

		try {
			await action.redo();
		} catch (err) {
			console.error("Redo failed:", err);
			return;
		}

		const newUndo = [...undoStack, action];
		set({
			undoStack: newUndo,
			redoStack: newRedo,
			canUndo: true,
			canRedo: newRedo.length > 0,
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
