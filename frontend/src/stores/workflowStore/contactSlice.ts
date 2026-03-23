import { invoke } from "@tauri-apps/api/core";
import type { Contact } from "@/types";
import { useUndoStore } from "@/stores/undoStore";
import { extractFilename } from "@/utils/path";
import type { WorkflowSlice } from "./types";

export const createContactSlice: WorkflowSlice = (set, get) => ({
	addContact: async (contact) => {
		const { workingDir } = get();
		if (!workingDir) throw new Error("No working directory");

		const created = await invoke<Contact>("add_contact", {
			workingDir,
			contact: { id: "", ...contact },
		});
		await get().reloadLilyFile();
		useUndoStore.getState().push({
			description: `Add contact ${contact.full_name}`,
			timestamp: Date.now(),
			redo: async () => {
				await invoke<Contact>("add_contact", {
					workingDir,
					contact: created,
				});
				await get().reloadLilyFile();
			},
			undo: async () => {
				await invoke("delete_contact", {
					workingDir,
					contactId: created.id,
				});
				await get().reloadLilyFile();
			},
		});
		return created;
	},

	updateContact: async (contact) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldContact = get().lilyFile?.contacts.find(
			(c) => c.id === contact.id,
		);
		await invoke("update_contact", { workingDir, contact });
		await get().reloadLilyFile();
		if (oldContact) {
			useUndoStore.getState().push({
				description: `Update contact ${contact.full_name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("update_contact", { workingDir, contact });
					await get().reloadLilyFile();
				},
				undo: async () => {
					await invoke("update_contact", {
						workingDir,
						contact: oldContact,
					});
					await get().reloadLilyFile();
				},
			});
		}
	},

	deleteContact: async (contactId) => {
		const { workingDir } = get();
		if (!workingDir) return;

		const oldContact = get().lilyFile?.contacts.find(
			(c) => c.id === contactId,
		);
		await invoke("delete_contact", { workingDir, contactId });
		await get().reloadLilyFile();
		if (oldContact) {
			useUndoStore.getState().push({
				description: `Delete contact ${oldContact.full_name}`,
				timestamp: Date.now(),
				redo: async () => {
					await invoke("delete_contact", {
						workingDir,
						contactId,
					});
					await get().reloadLilyFile();
				},
				undo: async () => {
					await invoke<Contact>("add_contact", {
						workingDir,
						contact: oldContact,
					});
					await get().reloadLilyFile();
				},
			});
		}
	},

	setContactBinding: async (role, binding) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		const bindings = { ...(lilyFile?.contact_bindings ?? {}) };
		bindings[role] = binding;
		await invoke("save_contact_bindings", {
			workingDir,
			contactBindings: bindings,
		});
		await invoke("resolve_contact_variables", { workingDir });
		await get().reloadLilyFile();

		const { lilyFile: updatedLily, variableValues } = get();
		if (updatedLily) {
			const merged = { ...variableValues };
			for (const varName of Object.keys(binding.variable_mappings)) {
				if (updatedLily.variables[varName] !== undefined) {
					merged[varName] = updatedLily.variables[varName];
				}
			}
			set({ variableValues: merged, dirty: true });
		}
	},

	clearContactBinding: async (role) => {
		const { workingDir, lilyFile } = get();
		if (!workingDir) return;

		const bindings = { ...(lilyFile?.contact_bindings ?? {}) };
		delete bindings[role];
		await invoke("save_contact_bindings", {
			workingDir,
			contactBindings: bindings,
		});
		await get().reloadLilyFile();
	},

	setRoleOverride: async (role, overrideData) => {
		const { workingDir, documentPath } = get();
		if (!workingDir || !documentPath) return;

		const filename = extractFilename(documentPath);
		await invoke("set_role_override", {
			workingDir,
			filename,
			role,
			overrideData,
		});
		await get().reloadLilyFile();
	},

	resolveContactBindings: async () => {
		const { workingDir } = get();
		if (!workingDir) return;

		await invoke("resolve_contact_variables", { workingDir });
		await get().reloadLilyFile();
	},
});
