import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";

/**
 * Persistent status bar at the bottom of the app window.
 * Provides quick access to settings, folder shortcuts, theme, and zoom.
 */
export default function StatusBar() {
	const { settings, toggleTheme, zoomIn, zoomOut, zoomReset } =
		useSettingsStore();
	const step = useWorkflowStore((s) => s.step);
	const workingDir = useWorkflowStore((s) => s.workingDir);
	const goToSettings = useWorkflowStore((s) => s.goToSettings);

	const isDark = settings.theme === "dark";
	const zoom = settings.zoom ?? 100;
	const footerSize = settings.footer_size ?? "medium";
	const sizeClasses =
		footerSize === "small"
			? "h-6 text-[10px]"
			: footerSize === "large"
				? "h-9 text-xs"
				: "h-7 text-[11px]";
	const iconSize =
		footerSize === "small"
			? "size-2.5"
			: footerSize === "large"
				? "size-3.5"
				: "size-3";

	const openFolder = async (path: string) => {
		try {
			await invoke("open_file_in_os", { filePath: path });
		} catch (err) {
			console.error("Failed to open folder:", err);
		}
	};

	// Determine which folder to open based on context
	const folderPath = workingDir ?? settings.templates_dir;
	const folderLabel = workingDir
		? "Open client folder"
		: settings.templates_dir
			? "Open templates folder"
			: null;

	return (
		<footer className={`flex items-center justify-between px-2 border-t border-base-300 bg-base-100 text-base-content/60 shrink-0 select-none ${sizeClasses}`}>
			{/* Left side */}
			<div className="flex items-center gap-0.5">
				{/* Settings */}
				<button
					type="button"
					className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-base-200 hover:text-base-content transition-colors"
					onClick={goToSettings}
					title="Settings"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 16 16"
						fill="currentColor"
						className={iconSize}
					>
						<title>Settings</title>
						<path
							fillRule="evenodd"
							d="M6.455 1.45A.5.5 0 0 1 6.952 1h2.096a.5.5 0 0 1 .497.45l.186 1.858a4.996 4.996 0 0 1 1.466.848l1.703-.769a.5.5 0 0 1 .639.206l1.048 1.814a.5.5 0 0 1-.142.656l-1.517 1.09a5.026 5.026 0 0 1 0 1.694l1.517 1.09a.5.5 0 0 1 .142.656l-1.048 1.814a.5.5 0 0 1-.639.206l-1.703-.769c-.433.36-.928.649-1.466.848l-.186 1.858a.5.5 0 0 1-.497.45H6.952a.5.5 0 0 1-.497-.45l-.186-1.858a4.993 4.993 0 0 1-1.466-.848l-1.703.769a.5.5 0 0 1-.639-.206L1.413 9.814a.5.5 0 0 1 .142-.656l1.517-1.09a5.026 5.026 0 0 1 0-1.694l-1.517-1.09a.5.5 0 0 1-.142-.656L2.46 2.814a.5.5 0 0 1 .639-.206l1.703.769c.433-.36.928-.649 1.466-.848L6.455 1.45ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
							clipRule="evenodd"
						/>
					</svg>
				</button>

				{/* Open folder */}
				{folderPath && (
					<button
						type="button"
						className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-base-200 hover:text-base-content transition-colors"
						onClick={() => openFolder(folderPath)}
						title={folderLabel ?? "Open folder"}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							className={iconSize}
						>
							<title>Open folder</title>
							<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H12.5A1.5 1.5 0 0 1 14 5.5v1.401a2.986 2.986 0 0 0-1.5-.401h-9c-.546 0-1.059.146-1.5.401V3.5ZM2 11.5v-3A1.5 1.5 0 0 1 3.5 7h9A1.5 1.5 0 0 1 14 8.5v3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
						</svg>
					</button>
				)}

				{/* Divider + context breadcrumb */}
				{step !== "hub" && (
					<>
						<span className="mx-1 text-base-content/20">|</span>
						<span className="text-base-content/40 truncate max-w-64">
							{getStepLabel(step, workingDir)}
						</span>
					</>
				)}
			</div>

			{/* Right side */}
			<div className="flex items-center gap-0.5">
				{/* Theme toggle */}
				<button
					type="button"
					className="flex items-center px-1.5 py-0.5 rounded hover:bg-base-200 hover:text-base-content transition-colors"
					onClick={toggleTheme}
					title={
						isDark ? "Switch to light mode" : "Switch to dark mode"
					}
				>
					{isDark ? (
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							className={iconSize}
						>
							<title>Light mode</title>
							<path d="M8 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 1ZM10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM12.95 4.11a.75.75 0 1 0-1.06-1.06l-1.062 1.06a.75.75 0 0 0 1.061 1.062l1.06-1.061ZM15 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 15 8ZM11.828 11.828a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 1 0 1.06 1.06l1.061-1.06ZM8 13.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13.5ZM4.11 12.95a.75.75 0 1 0 1.06-1.06l-1.06-1.062a.75.75 0 0 0-1.062 1.061l1.061 1.06ZM2.5 8a.75.75 0 0 1-.75.75H.25a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 2.5 8ZM4.11 3.05a.75.75 0 1 0-1.06 1.06l1.06 1.062a.75.75 0 0 0 1.062-1.061L4.11 3.05Z" />
						</svg>
					) : (
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							className={iconSize}
						>
							<title>Dark mode</title>
							<path d="M14.438 10.148c.19-.425-.321-.787-.748-.601A5.5 5.5 0 0 1 6.453 2.31c.186-.427-.176-.938-.6-.748a6.501 6.501 0 1 0 8.585 8.586Z" />
						</svg>
					)}
				</button>

				<span className="mx-1 text-base-content/20">|</span>

				{/* Zoom controls */}
				{zoom !== 100 && (
					<button
						type="button"
						className="px-1.5 py-0.5 rounded hover:bg-base-200 hover:text-base-content transition-colors"
						onClick={zoomReset}
						title="Reset zoom to 100%"
					>
						Reset
					</button>
				)}
				<button
					type="button"
					className="px-1 py-0.5 rounded hover:bg-base-200 hover:text-base-content transition-colors font-mono tabular-nums"
					onClick={zoomReset}
					title="Reset zoom (Ctrl+0)"
				>
					{zoom}%
				</button>
			</div>
		</footer>
	);
}

/** Human-readable label for the current workflow step. */
function getStepLabel(
	step: string,
	workingDir: string | null,
): string {
	const folderName = workingDir
		? workingDir
				.replace(/\\/g, "/")
				.split("/")
				.filter(Boolean)
				.pop() ?? workingDir
		: "";

	switch (step) {
		case "client-hub":
			return folderName;
		case "questionnaire":
			return `${folderName} \u203A Questionnaire`;
		case "select-template":
			return `${folderName} \u203A Add Document`;
		case "edit-variables":
			return `${folderName} \u203A Edit Document`;
		case "app-settings":
			return "Settings";
		case "pipeline":
			return "Pipeline";
		default:
			return "";
	}
}
