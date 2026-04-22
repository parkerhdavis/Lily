import { create } from "zustand";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
	id: string;
	type: ToastType;
	message: string;
}

interface ToastState {
	toasts: Toast[];
	/** Add a toast notification. Auto-dismisses after the given duration (ms). */
	addToast: (type: ToastType, message: string, duration?: number) => void;
	removeToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
	toasts: [],
	addToast: (type, message, duration = 4000) => {
		const id = String(++nextId);
		set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
		setTimeout(() => {
			set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
		}, duration);
	},
	removeToast: (id) => {
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
	},
}));
