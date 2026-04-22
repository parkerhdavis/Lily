import { describe, expect, test, beforeEach } from "bun:test";
import { useUndoStore } from "@/stores/undoStore";
import type { UndoableAction } from "@/stores/undoStore";

let value = "";

function makeAction(
	description: string,
	newVal: string,
	oldVal: string,
	timestamp?: number,
): UndoableAction {
	return {
		description,
		timestamp: timestamp ?? Date.now(),
		redo: () => {
			value = newVal;
		},
		undo: () => {
			value = oldVal;
		},
	};
}

beforeEach(() => {
	useUndoStore.getState().clear();
	value = "";
});

describe("undoStore", () => {
	test("push adds an action", () => {
		useUndoStore.getState().push(makeAction("Change X", "a", ""));
		expect(useUndoStore.getState().canUndo).toBe(true);
		expect(useUndoStore.getState().undoStack).toHaveLength(1);
	});

	test("undo reverses the action", async () => {
		value = "a";
		useUndoStore.getState().push(makeAction("Change X", "a", ""));
		await useUndoStore.getState().undo();
		expect(value).toBe("");
		expect(useUndoStore.getState().canRedo).toBe(true);
	});

	test("redo re-applies the action", async () => {
		value = "a";
		useUndoStore.getState().push(makeAction("Change X", "a", ""));
		await useUndoStore.getState().undo();
		await useUndoStore.getState().redo();
		expect(value).toBe("a");
	});

	test("coalesces rapid changes with same description", () => {
		const now = Date.now();
		useUndoStore.getState().push(makeAction("Change X", "J", "", now));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "Jo", "J", now + 100));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "Joh", "Jo", now + 200));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "John", "Joh", now + 300));

		// Should coalesce into a single entry
		expect(useUndoStore.getState().undoStack).toHaveLength(1);
	});

	test("coalesced undo restores original value", async () => {
		const now = Date.now();
		value = "";
		useUndoStore.getState().push(makeAction("Change X", "J", "", now));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "Jo", "J", now + 100));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "John", "Jo", now + 200));

		value = "John";
		await useUndoStore.getState().undo();
		// Should undo to the ORIGINAL value, not just the previous keystroke
		expect(value).toBe("");
	});

	test("coalesced redo applies final value", async () => {
		const now = Date.now();
		value = "";
		useUndoStore.getState().push(makeAction("Change X", "J", "", now));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "John", "J", now + 100));

		value = "John";
		await useUndoStore.getState().undo();
		await useUndoStore.getState().redo();
		expect(value).toBe("John");
	});

	test("does not coalesce different descriptions", () => {
		const now = Date.now();
		useUndoStore.getState().push(makeAction("Change X", "a", "", now));
		useUndoStore
			.getState()
			.push(makeAction("Change Y", "b", "", now + 100));

		expect(useUndoStore.getState().undoStack).toHaveLength(2);
	});

	test("does not coalesce after time gap", () => {
		const now = Date.now();
		useUndoStore.getState().push(makeAction("Change X", "a", "", now));
		useUndoStore
			.getState()
			.push(makeAction("Change X", "ab", "a", now + 1000));

		expect(useUndoStore.getState().undoStack).toHaveLength(2);
	});

	test("clear resets stacks", () => {
		useUndoStore.getState().push(makeAction("Change X", "a", ""));
		useUndoStore.getState().clear();
		expect(useUndoStore.getState().undoStack).toHaveLength(0);
		expect(useUndoStore.getState().canUndo).toBe(false);
	});
});
