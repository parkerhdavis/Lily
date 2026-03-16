import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import DirectoryPicker from "@/components/DirectoryPicker";
import ClientHub from "@/components/ClientHub";
import TemplatePicker from "@/components/TemplatePicker";
import VariableEditor from "@/components/VariableEditor";

export default function App() {
	const { loaded, load } = useSettingsStore();
	const step = useWorkflowStore((s) => s.step);

	useEffect(() => {
		load();
	}, [load]);

	if (!loaded) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<span className="loading loading-spinner loading-lg" />
			</div>
		);
	}

	switch (step) {
		case "select-directory":
			return <DirectoryPicker />;
		case "client-hub":
			return <ClientHub />;
		case "select-template":
			return <TemplatePicker />;
		case "edit-variables":
			return <VariableEditor />;
	}
}
