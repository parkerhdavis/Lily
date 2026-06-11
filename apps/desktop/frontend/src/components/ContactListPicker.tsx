// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useMemo } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { QuestionDef } from "@/types/questionnaire";

type ContactListQuestion = Extract<QuestionDef, { kind: "contact-list" }>;

/** Read a contact property by key. */
function getProperty(contact: Record<string, string>, key: string): string {
	return contact[key] ?? "";
}

/**
 * Multi-select picker for a "contact-list" question: the user checks one or
 * more of the client's contacts, and their `property` values (default
 * full name) are aggregated — joined with "; " — into `listVariable`.
 * Selection is stored as `contact_ids` on the role's contact binding.
 */
export default function ContactListPicker({
	question,
}: {
	question: ContactListQuestion;
}) {
	const { lilyFile, setContactBinding } = useWorkflowStore();

	const contacts = lilyFile?.contacts ?? [];
	const bindings = lilyFile?.contact_bindings ?? {};
	const property = question.property ?? "full_name";

	const selectedIds = useMemo(
		() => bindings[question.role]?.contact_ids ?? [],
		[bindings, question.role],
	);

	const commit = useCallback(
		async (ids: string[]) => {
			await setContactBinding(question.role, {
				contact_id: null,
				contact_ids: ids,
				variable_mappings: { [question.listVariable]: property },
			});
		},
		[setContactBinding, question.role, question.listVariable, property],
	);

	const toggle = useCallback(
		async (id: string, checked: boolean) => {
			// Preserve selection order: drop any existing entry, then append on
			// add so the listed order matches the order contacts were checked.
			const next = checked
				? [...selectedIds.filter((x) => x !== id), id]
				: selectedIds.filter((x) => x !== id);
			await commit(next);
		},
		[selectedIds, commit],
	);

	// Preview of the joined value, in selection order.
	const preview = useMemo(
		() =>
			selectedIds
				.map(
					(id) =>
						contacts.find((c) => c.id === id) as unknown as
							| Record<string, string>
							| undefined,
				)
				.filter((c): c is Record<string, string> => Boolean(c))
				.map((c) => getProperty(c, property))
				.filter(Boolean)
				.join("; "),
		[selectedIds, contacts, property],
	);

	return (
		<div className="form-control w-full">
			<label className="label pb-1">
				<span className="label-text text-sm font-medium">{question.label}</span>
			</label>

			{contacts.length === 0 ? (
				<div className="pl-3 border-l-2 border-base-content/20 text-sm text-base-content/50 italic">
					No contacts yet — add people in the Client Contacts tab first.
				</div>
			) : (
				<div className="pl-3 border-l-2 border-primary/30 space-y-0.5">
					{contacts.map((c) => {
						const checked = selectedIds.includes(c.id);
						const rel =
							c.relationship === "Other" && c.other_relationship
								? c.other_relationship
								: c.relationship;
						return (
							<label
								key={c.id}
								className="label cursor-pointer justify-start gap-2 py-0.5"
							>
								<input
									type="checkbox"
									className="checkbox checkbox-sm checkbox-primary"
									checked={checked}
									onChange={(e) => toggle(c.id, e.target.checked)}
								/>
								<span className="label-text text-sm">
									{c.full_name}
									{rel ? (
										<span className="text-base-content/50"> ({rel})</span>
									) : null}
								</span>
							</label>
						);
					})}
				</div>
			)}

			{preview && (
				<div className="mt-2 pl-3 border-l-2 border-primary/30 text-xs text-base-content/60">
					<span className="text-base-content/50">Will list: </span>
					{preview}
				</div>
			)}
		</div>
	);
}
