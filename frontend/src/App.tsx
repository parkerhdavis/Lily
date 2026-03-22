import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import DirectoryPicker from "@/components/DirectoryPicker";
import ClientHub from "@/components/ClientHub";
import TemplatePicker from "@/components/TemplatePicker";
import VariableEditor from "@/components/VariableEditor";
import Questionnaire from "@/components/Questionnaire";
import ThemeToggle from "@/components/ThemeToggle";

export default function App() {
	const { loaded, load } = useSettingsStore();
	const step = useWorkflowStore((s) => s.step);

	useEffect(() => {
		load();
	}, [load]);

	if (!loaded) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen gap-3">
				<img
					src="/lily-icon-trans.png"
					alt="Loading Lily..."
					className="size-14 animate-lily-spin"
				/>
			</div>
		);
	}

	const page = (() => {
		switch (step) {
			case "select-directory":
				return <DirectoryPicker />;
			case "client-hub":
				return <ClientHub />;
			case "questionnaire":
				return <Questionnaire />;
			case "select-template":
				return <TemplatePicker />;
			case "edit-variables":
				return <VariableEditor />;
		}
	})();

	return (
		<>
			{page}
			<ThemeToggle />
		</>
	);
}
