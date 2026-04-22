import { describe, expect, test, beforeEach } from "bun:test";
import { useToastStore } from "@/stores/toastStore";

beforeEach(() => {
	useToastStore.setState({ toasts: [] });
});

describe("toastStore", () => {
	test("addToast adds a toast", () => {
		useToastStore.getState().addToast("success", "Saved!");
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0].type).toBe("success");
		expect(toasts[0].message).toBe("Saved!");
	});

	test("addToast assigns unique ids", () => {
		const store = useToastStore.getState();
		store.addToast("info", "First");
		store.addToast("info", "Second");
		const toasts = useToastStore.getState().toasts;
		expect(toasts).toHaveLength(2);
		expect(toasts[0].id).not.toBe(toasts[1].id);
	});

	test("removeToast removes by id", () => {
		useToastStore.getState().addToast("error", "Oops");
		const id = useToastStore.getState().toasts[0].id;
		useToastStore.getState().removeToast(id);
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	test("removeToast with unknown id is a no-op", () => {
		useToastStore.getState().addToast("info", "Keep me");
		useToastStore.getState().removeToast("nonexistent");
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
});
