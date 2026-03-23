import { useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import type { Contact } from "@/types";

/** Basic format validation for contact fields. Returns an error message or null. */
function validateContactField(
	key: string,
	value: string,
): string | null {
	if (!value.trim()) return null; // empty is ok
	if (key === "email" && !value.includes("@")) {
		return "Email should contain @";
	}
	if (key === "phone" && !/\d/.test(value)) {
		return "Phone should contain digits";
	}
	if (key === "zip" && value.trim().length > 0 && !/\d/.test(value)) {
		return "ZIP should contain digits";
	}
	return null;
}

/** The fields that make up a contact, in display order. */
const CONTACT_FIELDS: { key: keyof Omit<Contact, "id">; label: string }[] = [
	{ key: "full_name", label: "Full Name" },
	{ key: "first_name", label: "First Name" },
	{ key: "last_name", label: "Last Name" },
	{ key: "relationship", label: "Relationship" },
	{ key: "phone", label: "Phone" },
	{ key: "email", label: "Email" },
	{ key: "address", label: "Address" },
	{ key: "city", label: "City" },
	{ key: "state", label: "State" },
	{ key: "zip", label: "ZIP" },
];

const EMPTY_CONTACT: Omit<Contact, "id"> = {
	full_name: "",
	first_name: "",
	last_name: "",
	relationship: "",
	phone: "",
	email: "",
	address: "",
	city: "",
	state: "",
	zip: "",
};

export default function ContactManager({
	onClose,
}: {
	onClose: () => void;
}) {
	const { lilyFile, addContact, updateContact, deleteContact } =
		useWorkflowStore();

	const contacts = lilyFile?.contacts ?? [];

	const [editingContact, setEditingContact] = useState<Contact | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(
		null,
	);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const deleteDialogRef = useRef<HTMLDialogElement>(null);

	const handleAdd = () => {
		setEditingContact({ id: "", ...EMPTY_CONTACT });
		setIsNew(true);
		setTimeout(() => dialogRef.current?.showModal(), 0);
	};

	const handleEdit = (contact: Contact) => {
		setEditingContact({ ...contact });
		setIsNew(false);
		setTimeout(() => dialogRef.current?.showModal(), 0);
	};

	const handleSave = async () => {
		if (!editingContact) return;

		if (isNew) {
			const { id: _, ...rest } = editingContact;
			await addContact(rest);
		} else {
			await updateContact(editingContact);
		}
		dialogRef.current?.close();
		setEditingContact(null);
	};

	const handleDeleteClick = (id: string) => {
		setConfirmDeleteId(id);
		setTimeout(() => deleteDialogRef.current?.showModal(), 0);
	};

	const handleConfirmDelete = async () => {
		if (!confirmDeleteId) return;
		await deleteContact(confirmDeleteId);
		deleteDialogRef.current?.close();
		setConfirmDeleteId(null);
	};

	const handleCancelDelete = () => {
		deleteDialogRef.current?.close();
		setConfirmDeleteId(null);
	};

	const updateField = (key: keyof Contact, value: string) => {
		if (!editingContact) return;
		setEditingContact({ ...editingContact, [key]: value });
	};

	const deleteName =
		contacts.find((c) => c.id === confirmDeleteId)?.full_name ?? "";

	// Find roles bound to the contact being deleted
	const deleteRoles = confirmDeleteId
		? Object.entries(lilyFile?.contact_bindings ?? {})
				.filter(([_, b]) => b.contact_id === confirmDeleteId)
				.map(([role]) => role)
		: [];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between p-4 border-b border-base-300">
				<h3 className="text-lg font-bold">Contacts</h3>
				<div className="flex gap-2">
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={handleAdd}
					>
						+ Add Contact
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onClose}
					>
						Close
					</button>
				</div>
			</div>

			{/* Contact list */}
			<div className="flex-1 overflow-y-auto p-4">
				{contacts.length === 0 ? (
					<div className="text-sm text-base-content/50 text-center py-8">
						<p>No contacts yet.</p>
						<p className="mt-1">
							Add contacts to quickly fill in document variables.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{contacts.map((contact) => (
							<div
								key={contact.id}
								className="flex items-center gap-3 p-3 rounded-lg border border-base-300 hover:bg-base-200/50 transition-colors group"
							>
								<div className="flex-1 min-w-0">
									<div className="font-medium truncate">
										{contact.full_name || "Unnamed"}
									</div>
									<div className="text-xs text-base-content/50 truncate">
										{[
											contact.relationship,
											contact.phone,
											contact.email,
										]
											.filter(Boolean)
											.join(" \u00B7 ") || "No details"}
									</div>
								</div>
								<button
									type="button"
									className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100"
									onClick={() => handleEdit(contact)}
								>
									Edit
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100"
									onClick={() =>
										handleDeleteClick(contact.id)
									}
								>
									&times;
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Edit/Add contact dialog */}
			{editingContact && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close
				<dialog
					ref={dialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === dialogRef.current) {
							dialogRef.current?.close();
							setEditingContact(null);
						}
					}}
				>
					<div className="modal-box max-w-lg">
						<h3 className="text-lg font-bold mb-4">
							{isNew ? "Add Contact" : "Edit Contact"}
						</h3>
						<div className="grid grid-cols-2 gap-3">
							{CONTACT_FIELDS.map(({ key, label }) => (
								<div
									key={key}
									className={
										key === "full_name" ||
										key === "address"
											? "col-span-2"
											: ""
									}
								>
									<label className="label pb-0.5">
										<span className="label-text text-xs">
											{label}
										</span>
									</label>
									<input
										type={key === "email" ? "email" : key === "phone" ? "tel" : "text"}
										className={`input input-bordered input-sm w-full ${validateContactField(key, editingContact[key as keyof Contact] ?? "") ? "input-warning" : ""}`}
										value={
											editingContact[
												key as keyof Contact
											] ?? ""
										}
										onChange={(e) =>
											updateField(
												key as keyof Contact,
												e.target.value,
											)
										}
									/>
									{validateContactField(key, editingContact[key as keyof Contact] ?? "") && (
										<p className="text-xs text-warning mt-0.5">
											{validateContactField(key, editingContact[key as keyof Contact] ?? "")}
										</p>
									)}
								</div>
							))}
						</div>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									dialogRef.current?.close();
									setEditingContact(null);
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={handleSave}
								disabled={!editingContact.full_name.trim()}
							>
								{isNew ? "Add" : "Save"}
							</button>
						</div>
					</div>
				</dialog>
			)}

			{/* Delete confirmation dialog */}
			{confirmDeleteId && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close
				<dialog
					ref={deleteDialogRef}
					className="modal"
					onClick={(e) => {
						if (e.target === deleteDialogRef.current)
							handleCancelDelete();
					}}
				>
					<div className="modal-box">
						<h3 className="text-lg font-bold mb-2">
							Delete contact?
						</h3>
						<p className="text-base-content/70 mb-4">
							Are you sure you want to delete{" "}
							<strong>{deleteName}</strong>? Any role bindings
							referencing this contact will be cleared.
						</p>
						{deleteRoles.length > 0 && (
							<div className="alert alert-warning text-sm mb-4">
								<span>
									Variables filled by this contact for{" "}
									{deleteRoles.join(", ")} will be left
									with their current values but may now
									be stale.
								</span>
							</div>
						)}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={handleCancelDelete}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error btn-sm"
								onClick={handleConfirmDelete}
							>
								Delete
							</button>
						</div>
					</div>
				</dialog>
			)}
		</div>
	);
}
