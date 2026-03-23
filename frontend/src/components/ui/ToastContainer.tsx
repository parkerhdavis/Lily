import type { ReactNode } from "react";
import { useToastStore } from "@/stores/toastStore";
import type { ToastType } from "@/stores/toastStore";

const alertClass: Record<ToastType, string> = {
	success: "alert-success",
	error: "alert-error",
	warning: "alert-warning",
	info: "alert-info",
};

const icons: Record<ToastType, ReactNode> = {
	success: (
		<svg xmlns="http://www.w3.org/2000/svg" className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<title>Success</title>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
	),
	error: (
		<svg xmlns="http://www.w3.org/2000/svg" className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<title>Error</title>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
	),
	warning: (
		<svg xmlns="http://www.w3.org/2000/svg" className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<title>Warning</title>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
		</svg>
	),
	info: (
		<svg xmlns="http://www.w3.org/2000/svg" className="size-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<title>Info</title>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
	),
};

export default function ToastContainer() {
	const toasts = useToastStore((s) => s.toasts);
	const removeToast = useToastStore((s) => s.removeToast);

	if (toasts.length === 0) return null;

	return (
		<div className="toast toast-end toast-bottom z-50 mb-14">
			{toasts.map((t) => (
				<div
					key={t.id}
					className={`alert ${alertClass[t.type]} shadow-lg cursor-pointer max-w-sm`}
					// biome-ignore lint/a11y/useKeyWithClickEvents: toast dismiss on click
					onClick={() => removeToast(t.id)}
				>
					{icons[t.type]}
					<span className="text-sm">{t.message}</span>
				</div>
			))}
		</div>
	);
}
