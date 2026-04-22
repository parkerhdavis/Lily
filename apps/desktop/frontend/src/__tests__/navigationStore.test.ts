import { describe, expect, test, beforeEach } from "bun:test";
import { useNavigationStore } from "@/stores/navigationStore";
import type { NavigationEntry } from "@/stores/navigationStore";

function entry(label: string): NavigationEntry {
	return {
		step: "hub",
		workingDir: null,
		documentPath: null,
		templateRelPath: null,
		label,
	};
}

beforeEach(() => {
	useNavigationStore.getState().clear();
});

describe("navigationStore", () => {
	test("starts empty", () => {
		const state = useNavigationStore.getState();
		expect(state.history).toHaveLength(0);
		expect(state.canGoBack).toBe(false);
		expect(state.canGoForward).toBe(false);
		expect(state.current()).toBeNull();
	});

	test("push adds entries", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		store.push(entry("B"));
		expect(useNavigationStore.getState().history).toHaveLength(2);
		expect(useNavigationStore.getState().current()?.label).toBe("B");
	});

	test("canGoBack is true after two pushes", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		expect(useNavigationStore.getState().canGoBack).toBe(false);
		store.push(entry("B"));
		expect(useNavigationStore.getState().canGoBack).toBe(true);
	});

	test("goBack returns previous entry", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		store.push(entry("B"));
		const result = useNavigationStore.getState().goBack();
		expect(result?.label).toBe("A");
		expect(useNavigationStore.getState().canGoForward).toBe(true);
	});

	test("goForward returns next entry", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		store.push(entry("B"));
		useNavigationStore.getState().goBack();
		const result = useNavigationStore.getState().goForward();
		expect(result?.label).toBe("B");
	});

	test("push after goBack truncates forward history", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		store.push(entry("B"));
		store.push(entry("C"));
		useNavigationStore.getState().goBack();
		useNavigationStore.getState().goBack();
		// Now at A, push D — should truncate B and C
		useNavigationStore.getState().push(entry("D"));
		expect(useNavigationStore.getState().history).toHaveLength(2);
		expect(useNavigationStore.getState().current()?.label).toBe("D");
		expect(useNavigationStore.getState().canGoForward).toBe(false);
	});

	test("goBack at start returns null", () => {
		useNavigationStore.getState().push(entry("A"));
		expect(useNavigationStore.getState().goBack()).toBeNull();
	});

	test("goForward at end returns null", () => {
		useNavigationStore.getState().push(entry("A"));
		expect(useNavigationStore.getState().goForward()).toBeNull();
	});

	test("clear resets state", () => {
		const store = useNavigationStore.getState();
		store.push(entry("A"));
		store.push(entry("B"));
		useNavigationStore.getState().clear();
		expect(useNavigationStore.getState().history).toHaveLength(0);
		expect(useNavigationStore.getState().canGoBack).toBe(false);
	});
});
