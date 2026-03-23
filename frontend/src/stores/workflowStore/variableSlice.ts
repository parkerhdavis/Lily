import { invoke } from "@tauri-apps/api/core";
import { useUndoStore } from "@/stores/undoStore";
import { toastError } from "./helpers";
import type { WorkflowSlice } from "./types";

export const createVariableSlice: WorkflowSlice = (set, get) => ({
	updateVariable: (name, value) => {
		const { variableValues } = get();
		const oldValue = variableValues[name] ?? "";
		set({
			variableValues: { ...variableValues, [name]: value },
			dirty: true,
		});
		useUndoStore.getState().push({
			description: `Change ${name}`,
			timestamp: Date.now(),
			redo: () => {
				const s = get();
				set({
					variableValues: { ...s.variableValues, [name]: value },
					dirty: true,
				});
			},
			undo: () => {
				const s = get();
				set({
					variableValues: { ...s.variableValues, [name]: oldValue },
					dirty: true,
				});
			},
		});
	},

	saveClientVariable: async (name, value) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldValue = get().lilyFile?.variables[name] ?? "";
		try {
			await invoke("save_client_variables", {
				workingDir,
				variableValues: { [name]: value },
			});
			const { lilyFile } = get();
			if (lilyFile) {
				set({
					lilyFile: {
						...lilyFile,
						variables: { ...lilyFile.variables, [name]: value },
					},
				});
			}
			useUndoStore.getState().push({
				description: `Change client variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: value },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: value,
								},
							},
						});
					}
				},
				undo: async () => {
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: oldValue },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: oldValue,
								},
							},
						});
					}
				},
			});
		} catch (err) {
			console.error("Failed to save client variable:", err);
			toastError("Failed to save variable", err);
		}
	},

	addClientVariable: async (name) => {
		const { workingDir } = get();
		if (!workingDir) return;

		try {
			await invoke("add_client_variable", {
				workingDir,
				variableName: name,
			});
			const { lilyFile } = get();
			if (lilyFile) {
				set({
					lilyFile: {
						...lilyFile,
						variables: { ...lilyFile.variables, [name]: "" },
					},
				});
			}
			useUndoStore.getState().push({
				description: `Add variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("add_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: { ...lf.variables, [name]: "" },
							},
						});
					}
				},
				undo: async () => {
					await invoke("remove_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						const { [name]: _, ...rest } = lf.variables;
						set({ lilyFile: { ...lf, variables: rest } });
					}
				},
			});
		} catch (err) {
			throw err;
		}
	},

	removeClientVariable: async (name) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldValue = get().lilyFile?.variables[name] ?? "";
		try {
			await invoke("remove_client_variable", {
				workingDir,
				variableName: name,
			});
			const { lilyFile } = get();
			if (lilyFile) {
				const { [name]: _, ...rest } = lilyFile.variables;
				set({
					lilyFile: {
						...lilyFile,
						variables: rest,
					},
				});
			}
			useUndoStore.getState().push({
				description: `Remove variable ${name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("remove_client_variable", {
						workingDir,
						variableName: name,
					});
					const { lilyFile: lf } = get();
					if (lf) {
						const { [name]: _, ...rest } = lf.variables;
						set({ lilyFile: { ...lf, variables: rest } });
					}
				},
				undo: async () => {
					await invoke("add_client_variable", {
						workingDir,
						variableName: name,
					});
					await invoke("save_client_variables", {
						workingDir,
						variableValues: { [name]: oldValue },
					});
					const { lilyFile: lf } = get();
					if (lf) {
						set({
							lilyFile: {
								...lf,
								variables: {
									...lf.variables,
									[name]: oldValue,
								},
							},
						});
					}
				},
			});
		} catch (err) {
			console.error("Failed to remove client variable:", err);
			toastError("Failed to remove variable", err);
		}
	},
});
