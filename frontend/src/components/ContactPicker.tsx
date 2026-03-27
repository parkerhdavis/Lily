import { useCallback, useMemo, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { Contact, ContactBinding } from "@/types";
import type { QuestionDef } from "@/types/questionnaire";

/** Contact property labels for display in the manual-entry fallback. */
const PROPERTY_LABELS: Record<string, string> = {
	full_name: "Full Name",
	first_name: "First Name",
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

export default function ContactPicker({
	question,
	onAddContact,
}: {
	question: Extract<QuestionDef, { kind: "contact-role" }>;
	onAddContact?: () => void;
}) {
	const {
		lilyFile,
		saveClientVariable,
		setContactBinding,
		clearContactBinding,
	} = useWorkflowStore();

	const contacts = lilyFile?.contacts ?? [];
	const variables = lilyFile?.variables ?? {};
	const bindings = lilyFile?.contact_bindings ?? {};
	const binding = bindings[question.role] as ContactBinding | undefined;

	const boundContactId = binding?.contact_id ?? null;
	const isNone = boundContactId === "__none__";
	const isOther = binding !== undefined && boundContactId === null;

	// Determine which contact is currently selected
	const selectedContact = useMemo(
		() => contacts.find((c) => c.id === boundContactId) ?? null,
		[contacts, boundContactId],
	);

	// Track local values for "Other" manual entry
	const [manualValues, setManualValues] = useState<Record<string, string>>(
		{},
	);

	// Sync manual values from variables when entering "Other" mode
	const [prevIsOther, setPrevIsOther] = useState(isOther);
	if (isOther && !prevIsOther) {
		const vals: Record<string, string> = {};
		for (const varName of Object.keys(question.variableMappings)) {
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
				// Explicitly "no one" for this role
				await setContactBinding(question.role, {
					contact_id: "__none__",
					variable_mappings: question.variableMappings,
				});
			} else if (value === "__other__") {
				// Switch to manual entry — clear contact_id but keep mappings
				await setContactBinding(question.role, {
					contact_id: null,
					variable_mappings: question.variableMappings,
				});
			} else if (value === "__add__") {
				onAddContact?.();
			} else if (value === "") {
				// No selection — remove binding entirely
				await clearContactBinding(question.role);
			} else {
				// Selected a contact
				await setContactBinding(question.role, {
					contact_id: value,
					variable_mappings: question.variableMappings,
				});
			}
		},
		[question.role, question.variableMappings, setContactBinding, clearContactBinding, onAddContact],
	);

	const handleManualBlur = useCallback(
		async (varName: string, value: string) => {
			if (value !== (variables[varName] ?? "")) {
				await saveClientVariable(varName, value);
			}
		},
		[variables, saveClientVariable],
	);

	// Build the select value
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
				<span className="label-text text-sm font-medium">
					{question.label}
				</span>
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
						{c.relationship ? ` (${c.relationship})` : ""}
					</option>
				))}
				<option value="__other__">Other (manual entry)</option>
				{onAddContact && (
					<option value="__add__">+ New Contact...</option>
				)}
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
					{Object.entries(question.variableMappings).map(
						([varName, propKey]) => {
							const value = getProperty(
								selectedContact,
								propKey,
							);
							return (
								<div
									key={varName}
									className="flex items-center gap-2 text-xs"
								>
									<span className="text-base-content/50 min-w-24">
										{PROPERTY_LABELS[propKey] ?? propKey}:
									</span>
									<span
										className={
											value
												? "text-base-content"
												: "text-base-content/30 italic"
										}
									>
										{value || "empty"}
									</span>
								</div>
							);
						},
					)}
				</div>
			)}

			{/* Manual entry fields when "Other" is selected */}
			{isOther && (
				<div className="mt-2 pl-3 border-l-2 border-warning/30 space-y-2">
					{Object.entries(question.variableMappings).map(
						([varName, propKey]) => (
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
									value={
										manualValues[varName] ??
										variables[varName] ??
										""
									}
									onChange={(e) =>
										setManualValues((prev) => ({
											...prev,
											[varName]: e.target.value,
										}))
									}
									onBlur={(e) =>
										handleManualBlur(
											varName,
											e.target.value,
										)
									}
								/>
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}
