// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useMemo, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { Contact, ContactBinding } from "@/types";
import type { QuestionDef } from "@/types/questionnaire";

/** Contact property labels for display in the manual-entry fallback. */
const PROPERTY_LABELS: Record<string, string> = {
	full_name: "Full Name",
	first_name: "First Name",
	middle_name: "Middle Name",
	last_name: "Last Name",
	relationship: "Relationship",
	phone: "Phone",
	email: "Email",
	address: "Address",
	city: "City",
	state: "State",
	zip: "ZIP",
};

/** Read a contact property by key. */
function getProperty(contact: Contact, key: string): string {
	return (contact as unknown as Record<string, string>)[key] ?? "";
}

type ContactRoleQuestion = Extract<QuestionDef, { kind: "contact-role" }>;

/** A single contact selection dropdown with resolved values / manual entry. */
function SingleContactPicker({
	role,
	label,
	variableMappings,
	contacts,
	variables,
	bindings,
	onAddContact,
}: {
	role: string;
	label: string;
	variableMappings: Record<string, string>;
	contacts: Contact[];
	variables: Record<string, string>;
	bindings: Record<string, ContactBinding>;
	onAddContact?: () => void;
}) {
	const { saveClientVariable, setContactBinding, clearContactBinding } =
		useWorkflowStore();

	const binding = bindings[role] as ContactBinding | undefined;
	const boundContactId = binding?.contact_id ?? null;
	const isNone = boundContactId === "__none__";
	const isOther = binding !== undefined && boundContactId === null;

	const selectedContact = useMemo(
		() => contacts.find((c) => c.id === boundContactId) ?? null,
		[contacts, boundContactId],
	);

	const [manualValues, setManualValues] = useState<Record<string, string>>({});

	const [prevIsOther, setPrevIsOther] = useState(isOther);
	if (isOther && !prevIsOther) {
		const vals: Record<string, string> = {};
		for (const varName of Object.keys(variableMappings)) {
			vals[varName] = variables[varName] ?? "";
		}
		setManualValues(vals);
	}
	if (isOther !== prevIsOther) {
		setPrevIsOther(isOther);
	}

	const handleSelectChange = useCallback(
		async (value: string) => {
			if (value === "__none__") {
				await setContactBinding(role, {
					contact_id: "__none__",
					variable_mappings: variableMappings,
				});
			} else if (value === "__other__") {
				await setContactBinding(role, {
					contact_id: null,
					variable_mappings: variableMappings,
				});
			} else if (value === "__add__") {
				onAddContact?.();
			} else if (value === "") {
				await clearContactBinding(role);
			} else {
				await setContactBinding(role, {
					contact_id: value,
					variable_mappings: variableMappings,
				});
			}
		},
		[
			role,
			variableMappings,
			setContactBinding,
			clearContactBinding,
			onAddContact,
		],
	);

	const handleManualBlur = useCallback(
		async (varName: string, value: string) => {
			if (value !== (variables[varName] ?? "")) {
				await saveClientVariable(varName, value);
			}
		},
		[variables, saveClientVariable],
	);

	const selectValue = selectedContact
		? selectedContact.id
		: isNone
			? "__none__"
			: isOther
				? "__other__"
				: "";

	return (
		<div className="form-control w-full">
			<label className="label pb-1">
				<span className="label-text text-sm font-medium">{label}</span>
			</label>

			{/* Contact dropdown */}
			<select
				className="select select-bordered select-sm w-full"
				value={selectValue}
				onChange={(e) => handleSelectChange(e.target.value)}
			>
				<option value="">Select a contact...</option>
				<option value="__none__">None</option>
				{contacts.map((c) => (
					<option key={c.id} value={c.id}>
						{c.full_name}
						{c.relationship
							? ` (${c.relationship === "Other" && c.other_relationship ? c.other_relationship : c.relationship})`
							: ""}
					</option>
				))}
				<option value="__other__">Other (manual entry)</option>
				{onAddContact && <option value="__add__">+ New Contact...</option>}
			</select>

			{/* None selected */}
			{isNone && (
				<div className="mt-2 pl-3 border-l-2 border-base-content/20 text-sm text-base-content/50 italic">
					No one assigned to this role
				</div>
			)}

			{/* Show resolved values when a contact is selected */}
			{selectedContact && (
				<div className="mt-2 pl-3 border-l-2 border-primary/30 space-y-1">
					{Object.entries(variableMappings).map(([varName, propKey]) => {
						const value = getProperty(selectedContact, propKey);
						return (
							<div key={varName} className="flex items-center gap-2 text-xs">
								<span className="text-base-content/50 min-w-24">
									{PROPERTY_LABELS[propKey] ?? propKey}:
								</span>
								<span
									className={
										value ? "text-base-content" : "text-base-content/30 italic"
									}
								>
									{value || "empty"}
								</span>
							</div>
						);
					})}
				</div>
			)}

			{/* Manual entry fields when "Other" is selected */}
			{isOther && (
				<div className="mt-2 pl-3 border-l-2 border-warning/30 space-y-2">
					{Object.entries(variableMappings).map(([varName, propKey]) => (
						<div key={varName}>
							<label className="label pb-0.5">
								<span className="label-text text-xs text-base-content/60">
									{PROPERTY_LABELS[propKey] ?? propKey}
								</span>
							</label>
							<input
								type="text"
								className="input input-bordered input-xs w-full"
								placeholder={`Enter ${PROPERTY_LABELS[propKey] ?? propKey}`}
								value={manualValues[varName] ?? variables[varName] ?? ""}
								onChange={(e) =>
									setManualValues((prev) => ({
										...prev,
										[varName]: e.target.value,
									}))
								}
								onBlur={(e) => handleManualBlur(varName, e.target.value)}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default function ContactPicker({
	question,
	onAddContact,
}: {
	question: ContactRoleQuestion;
	onAddContact?: () => void;
}) {
	const { lilyFile, clearContactBinding } = useWorkflowStore();

	const contacts = lilyFile?.contacts ?? [];
	const variables = lilyFile?.variables ?? {};
	const bindings = lilyFile?.contact_bindings ?? {};

	const hasCoAgent = Boolean(
		question.coAgentRole && question.coAgentVariableMappings,
	);
	const bindingExists =
		hasCoAgent && bindings[question.coAgentRole!] !== undefined;

	// Local toggle state — initialised from the binding so it stays in
	// sync on mount / reload, but lets the user open the picker before
	// they've actually selected a contact.
	const [coAgentOpen, setCoAgentOpen] = useState(bindingExists);

	// Keep local state in sync when the binding appears or disappears
	// externally (e.g. file reload).
	const [prevBindingExists, setPrevBindingExists] = useState(bindingExists);
	if (bindingExists !== prevBindingExists) {
		setPrevBindingExists(bindingExists);
		if (bindingExists && !coAgentOpen) setCoAgentOpen(true);
	}

	const handleToggleCoAgent = useCallback(async () => {
		if (coAgentOpen) {
			// Toggling off — clear binding if one exists
			setCoAgentOpen(false);
			if (bindingExists) {
				await clearContactBinding(question.coAgentRole!);
			}
		} else {
			// Toggling on — just show the picker
			setCoAgentOpen(true);
		}
	}, [coAgentOpen, bindingExists, question.coAgentRole, clearContactBinding]);

	return (
		<div className="form-control w-full">
			<SingleContactPicker
				role={question.role}
				label={question.label}
				variableMappings={question.variableMappings}
				contacts={contacts}
				variables={variables}
				bindings={bindings}
				onAddContact={onAddContact}
			/>

			{hasCoAgent && (
				<div className="mt-2">
					<label className="label cursor-pointer justify-start gap-2 py-1">
						<input
							type="checkbox"
							className="toggle toggle-sm toggle-primary"
							checked={coAgentOpen}
							onChange={handleToggleCoAgent}
						/>
						<span className="label-text text-xs text-base-content/60">
							Assign co-agent
						</span>
					</label>

					{coAgentOpen && (
						<div className="mt-1 ml-4 pl-3 border-l-2 border-secondary/30">
							<SingleContactPicker
								role={question.coAgentRole!}
								label={`Co-Agent for ${question.label}`}
								variableMappings={question.coAgentVariableMappings!}
								contacts={contacts}
								variables={variables}
								bindings={bindings}
								onAddContact={onAddContact}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
