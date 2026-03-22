import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import LilyHub from "@/components/LilyHub";
import ClientHub from "@/components/ClientHub";
import TemplatePicker from "@/components/TemplatePicker";
import VariableEditor from "@/components/VariableEditor";
import Questionnaire from "@/components/Questionnaire";
import AppSettings from "@/components/AppSettings";
import PipelineHub from "@/components/PipelineHub";
import ThemeToggle from "@/components/ThemeToggle";

export default function App() {
	const { loaded, load, zoomIn, zoomOut, zoomReset } = useSettingsStore();
	const step = useWorkflowStore((s) => s.step);
	const [splashDone, setSplashDone] = useState(false);
	const [fadeOut, setFadeOut] = useState(false);

	useEffect(() => {
		load();
	}, [load]);

	// Global zoom keyboard shortcuts: Ctrl+= / Ctrl+- / Ctrl+0
	useEffect(() => {
		const handleZoom = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			if (e.key === "=" || e.key === "+") {
				e.preventDefault();
				zoomIn();
			} else if (e.key === "-") {
				e.preventDefault();
				zoomOut();
			} else if (e.key === "0") {
				e.preventDefault();
				zoomReset();
			}
		};
		window.addEventListener("keydown", handleZoom);
		return () => window.removeEventListener("keydown", handleZoom);
	}, [zoomIn, zoomOut, zoomReset]);

	// Splash: wait for settings to load + minimum display time, then fade out
	useEffect(() => {
		if (!loaded) return;
		const fadeTimer = setTimeout(() => setFadeOut(true), 1200);
		const doneTimer = setTimeout(() => setSplashDone(true), 1500);
		return () => {
			clearTimeout(fadeTimer);
			clearTimeout(doneTimer);
		};
	}, [loaded]);

	if (!splashDone) {
		return (
			<div
				className={`flex flex-col items-center justify-center min-h-screen gap-3 transition-opacity duration-300 ${fadeOut ? "opacity-0" : "opacity-100"}`}
			>
				<img
					src="/lily-icon-trans.png"
					alt="Loading Lily..."
					className="size-16 animate-lily-spin"
				/>
				<span className="text-xl font-bold tracking-tight animate-fade-in-up">
					Lily
				</span>
			</div>
		);
	}

	const page = (() => {
		switch (step) {
			case "hub":
				return <LilyHub />;
			case "client-hub":
				return <ClientHub />;
			case "questionnaire":
				return <Questionnaire />;
			case "select-template":
				return <TemplatePicker />;
			case "edit-variables":
				return <VariableEditor />;
			case "app-settings":
				return <AppSettings />;
			case "pipeline":
				return <PipelineHub />;
		}
	})();

	return (
		<>
			{page}
			<ThemeToggle />
		</>
	);
}
