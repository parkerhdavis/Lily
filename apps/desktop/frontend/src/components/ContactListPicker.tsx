// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { QuestionDef } from "@/types/questionnaire";

type ContactListQuestion = Extract<QuestionDef, { kind: "contact-list" }>;

interface Row {
	/** Stable React key, independent of the (possibly empty) contact id. */
	uid: string;
	/** The selected contact id, or "" for a not-yet-chosen row. */
	contactId: string;
}

/**
 * Ordered list of contacts for a "contact-list" question. Mirrors the Client
 * Contacts "+ Add" pattern, except each entry is a dropdown that selects an
 * existing contact rather than a full contact form. The selected contacts'
 * `property` values are aggregated — joined with "; " by the backend — into
 * `listVariable`. Selection is stored as the ordered `contact_ids` on the
 * role's contact binding; empty (not-yet-chosen) rows are kept only in local
 * state and are not persisted.
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

	const persistedIds = useMemo(
		() => bindings[question.role]?.contact_ids ?? [],
		[bindings, question.role],
	);

	const uidCounter = useRef(0);
	const makeRow = useCallback(
		(contactId: string): Row => ({
			uid: `r${uidCounter.current++}`,
			contactId,
		}),
		[],
	);

	const [rows, setRows] = useState<Row[]>(() => persistedIds.map(makeRow));

	// Re-sync from the persisted list when it diverges from the committed rows
	// (external change, or a late lilyFile load). Transient empty rows the user
	// just added don't change the persisted sequence, so they're preserved.
	useEffect(() => {
		setRows((prev) => {
			const committed = prev.map((r) => r.contactId).filter(Boolean);
			const same =
				committed.length === persistedIds.length &&
				committed.every((id, i) => id === persistedIds[i]);
			return same ? prev : persistedIds.map(makeRow);
		});
	}, [persistedIds, makeRow]);

	const commit = useCallback(
		(nextRows: Row[]) => {
			const ids = nextRows.map((r) => r.contactId).filter(Boolean);
			void setContactBinding(question.role, {
				contact_id: null,
				contact_ids: ids,
				variable_mappings: { [question.listVariable]: property },
			});
		},
		[setContactBinding, question.role, question.listVariable, property],
	);

	const addRow = () => setRows((prev) => [...prev, makeRow("")]);

	const selectRow = (uid: string, contactId: string) => {
		const next = rows.map((r) => (r.uid === uid ? { ...r, contactId } : r));
		setRows(next);
		commit(next);
	};

	const removeRow = (uid: string) => {
		const next = rows.filter((r) => r.uid !== uid);
		setRows(next);
		commit(next);
	};

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
				<div className="flex flex-col gap-2">
					{rows.map((row) => {
						// Don't offer contacts already chosen in other rows (no dupes),
						// but always keep this row's own current selection.
						const usedElsewhere = new Set(
							rows
								.filter((r) => r.uid !== row.uid && r.contactId)
								.map((r) => r.contactId),
						);
						const options = contacts.filter(
							(c) => c.id === row.contactId || !usedElsewhere.has(c.id),
						);
						return (
							<div key={row.uid} className="flex items-center gap-2">
								<select
									className="select select-bordered select-sm flex-1"
									value={row.contactId}
									onChange={(e) => selectRow(row.uid, e.target.value)}
								>
									<option value="">Select a contact…</option>
									{options.map((c) => {
										const rel =
											c.relationship === "Other" && c.other_relationship
												? c.other_relationship
												: c.relationship;
										return (
											<option key={c.id} value={c.id}>
												{c.full_name}
												{rel ? ` (${rel})` : ""}
											</option>
										);
									})}
								</select>
								<button
									type="button"
									className="btn btn-ghost btn-sm btn-square text-error"
									onClick={() => removeRow(row.uid)}
									title="Remove"
								>
									&times;
								</button>
							</div>
						);
					})}

					<button
						type="button"
						className="btn btn-outline btn-sm w-full"
						onClick={addRow}
					>
						+ Add
					</button>
				</div>
			)}
		</div>
	);
}
