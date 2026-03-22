import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { questionnaireDef } from "@/data/questionnaireDef";
import ContactPicker from "@/components/ContactPicker";
import type { QuestionDef } from "@/types/questionnaire";

/** Extract just the folder name from a full directory path. */
function getFolderName(dirPath: string): string {
	const segments = dirPath.replace(/\\/g, "/").split("/");
	return segments[segments.length - 1] || dirPath;
}

export default function Questionnaire() {
	const {
		workingDir,
		lilyFile,
		saveClientVariable,
		saveQuestionnaireNote,
		addContact,
		updateContact,
		deleteContact,
		returnToHub,
	} = useWorkflowStore();

	const variables = lilyFile?.variables ?? {};
	const contacts = lilyFile?.contacts ?? [];
	const notes = lilyFile?.questionnaire_notes ?? {};

	// Save-state indicator
	const [saveStatus, setSaveStatus] = useState<
		"idle" | "saving" | "saved"
	>("idle");
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showSaved = useCallback(() => {
		setSaveStatus("saved");
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
	}, []);

	// Wrap saveClientVariable to trigger save indicator
	const handleSaveVariable = useCallback(
		async (name: string, value: string) => {
			setSaveStatus("saving");
			await saveClientVariable(name, value);
			showSaved();
		},
		[saveClientVariable, showSaved],
	);

	// Wrap saveQuestionnaireNote to trigger save indicator
	const handleSaveNote = useCallback(
		async (
			section: string,
			noteKind: "client" | "internal",
			value: string,
		) => {
			setSaveStatus("saving");
			await saveQuestionnaireNote(section, noteKind, value);
			showSaved();
		},
		[saveQuestionnaireNote, showSaved],
	);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, []);

	// Track which sections are collapsed
	const [collapsedSections, setCollapsedSections] = useState<
		Record<number, boolean>
	>({});

	const toggleSection = (idx: number) => {
		setCollapsedSections((prev) => ({
			...prev,
			[idx]: !prev[idx],
		}));
	};

	// Compute completion stats (text fields only)
	const stats = useMemo(() => {
		let total = 0;
		let filled = 0;
		for (const section of questionnaireDef) {
			if (section.kind === "contacts") {
				// Count contacts as progress
				total++;
				if (contacts.length > 0) filled++;
				continue;
			}
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (variables[q.variable]?.trim()) filled++;
				}
			}
		}
		return { total, filled };
	}, [variables, contacts]);

	// Per-section completion
	const sectionStats = useMemo(() => {
		return questionnaireDef.map((section) => {
			if (section.kind === "contacts") {
				return {
					total: 1,
					filled: contacts.length > 0 ? 1 : 0,
					label: `${contacts.length} contact${contacts.length !== 1 ? "s" : ""}`,
				};
			}
			let total = 0;
			let filled = 0;
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (variables[q.variable]?.trim()) filled++;
				}
			}
			return { total, filled, label: null as string | null };
		});
	}, [variables, contacts]);

	const folderName = workingDir ? getFolderName(workingDir) : "Client";

	return (
		<div className="flex flex-col h-screen">
			{/* Header */}
			<div className="flex items-center gap-4 p-4 border-b border-base-300 bg-base-200">
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={returnToHub}
				>
					&larr; Back
				</button>
				<div className="flex-1 min-w-0">
					<h2 className="text-xl font-bold truncate">
						{folderName} &mdash; Questionnaire
					</h2>
				</div>
				<div className="text-sm text-base-content/60">
					{stats.filled} / {stats.total} fields filled
				</div>
				{/* Save-state indicator */}
				<div className="text-xs w-28 text-right">
					{saveStatus === "saving" && (
						<span className="text-warning flex items-center justify-end gap-1">
							<span className="loading loading-spinner loading-xs" />
							Saving...
						</span>
					)}
					{saveStatus === "saved" && (
						<span className="text-success">All changes saved</span>
					)}
				</div>
			</div>

			{/* Sections */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-2xl mx-auto flex flex-col gap-6">
					{questionnaireDef.map((section, sIdx) => {
						const collapsed = collapsedSections[sIdx] ?? false;
						const ss = sectionStats[sIdx];
						const isContacts = section.kind === "contacts";

						return (
							<div
								key={section.title}
								className="card bg-base-100 border border-base-300 shadow-sm"
							>
								{/* Section header — clickable to collapse */}
								<button
									type="button"
									className="flex items-center gap-3 p-4 w-full text-left hover:bg-base-200/50 transition-colors rounded-t-2xl"
									onClick={() => toggleSection(sIdx)}
								>
									<span
										className={`transition-transform text-base-content/40 ${collapsed ? "" : "rotate-90"}`}
									>
										&#9654;
									</span>
									<div className="flex-1 min-w-0">
										<h3 className="text-lg font-semibold">
											{section.title}
										</h3>
										{section.description && (
											<p className="text-sm text-base-content/50 mt-0.5">
												{section.description}
											</p>
										)}
									</div>
									<span className="text-xs text-base-content/40 shrink-0">
										{ss.label ??
											(ss.total > 0
												? `${ss.filled} / ${ss.total}`
												: "")}
									</span>
								</button>

								{/* Section body */}
								{!collapsed && (
									<div className="px-4 pb-4 flex flex-col gap-4 border-t border-base-200 pt-4">
										{isContacts ? (
											<InlineContactList
												contacts={contacts}
												onAdd={addContact}
												onUpdate={updateContact}
												onDelete={deleteContact}
											/>
										) : (
											section.questions.map((q) => (
												<QuestionField
													key={
														q.kind ===
														"contact-role"
															? q.role
															: q.variable
													}
													question={q}
													value={
														q.kind ===
														"contact-role"
															? ""
															: (variables[
																	q.variable
																] ?? "")
													}
													onSave={
														handleSaveVariable
													}
												/>
											))
										)}

										{/* Notes */}
										<SectionNotesFields
											sectionTitle={section.title}
											clientNotes={
												notes[section.title]
													?.client ?? ""
											}
											internalNotes={
												notes[section.title]
													?.internal ?? ""
											}
											onSave={handleSaveNote}
										/>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

// ─── Inline contact list for the "Client Contacts" section ──────────────────

function InlineContactList({
	contacts,
	onAdd,
	onUpdate,
	onDelete,
}: {
	contacts: { id: string; full_name: string; relationship: string; phone: string; email: string }[];
	onAdd: (contact: Omit<import("@/types").Contact, "id">) => Promise<import("@/types").Contact>;
	onUpdate: (contact: import("@/types").Contact) => Promise<void>;
	onDelete: (contactId: string) => Promise<void>;
}) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [isAdding, setIsAdding] = useState(false);

	return (
		<div className="space-y-3">
			{contacts.length === 0 && !isAdding && (
				<p className="text-sm text-base-content/50">
					No contacts added yet.
				</p>
			)}

			{contacts.map((c) =>
				editingId === c.id ? (
					<ContactEditForm
						key={c.id}
						contactId={c.id}
						onSave={async (contact) => {
							await onUpdate(contact);
							setEditingId(null);
						}}
						onCancel={() => setEditingId(null)}
					/>
				) : (
					<div
						key={c.id}
						className="flex items-center gap-3 p-3 rounded-lg border border-base-300 group"
					>
						<div className="flex-1 min-w-0">
							<div className="font-medium truncate">
								{c.full_name || "Unnamed"}
							</div>
							<div className="text-xs text-base-content/50 truncate">
								{[c.relationship, c.phone, c.email]
									.filter(Boolean)
									.join(" \u00B7 ") || "No details"}
							</div>
						</div>
						<button
							type="button"
							className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100"
							onClick={() => setEditingId(c.id)}
						>
							Edit
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100"
							onClick={() => onDelete(c.id)}
						>
							&times;
						</button>
					</div>
				),
			)}

			{isAdding ? (
				<ContactEditForm
					contactId={null}
					onSave={async (contact) => {
						const { id: _, ...rest } = contact;
						await onAdd(rest);
						setIsAdding(false);
					}}
					onCancel={() => setIsAdding(false)}
				/>
			) : (
				<button
					type="button"
					className="btn btn-outline btn-sm w-full"
					onClick={() => setIsAdding(true)}
				>
					+ Add Contact
				</button>
			)}
		</div>
	);
}

/** Inline form for adding/editing a contact. */
function ContactEditForm({
	contactId,
	onSave,
	onCancel,
}: {
	contactId: string | null;
	onSave: (contact: import("@/types").Contact) => Promise<void>;
	onCancel: () => void;
}) {
	const lilyFile = useWorkflowStore((s) => s.lilyFile);
	const existing = contactId
		? lilyFile?.contacts?.find((c) => c.id === contactId) ?? null
		: null;

	const [form, setForm] = useState({
		full_name: existing?.full_name ?? "",
		first_name: existing?.first_name ?? "",
		last_name: existing?.last_name ?? "",
		relationship: existing?.relationship ?? "",
		phone: existing?.phone ?? "",
		email: existing?.email ?? "",
		address: existing?.address ?? "",
		city: existing?.city ?? "",
		state: existing?.state ?? "",
		zip: existing?.zip ?? "",
	});

	const update = (key: string, value: string) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const handleSave = async () => {
		await onSave({ id: contactId ?? "", ...form });
	};

	const fields: { key: string; label: string; span2?: boolean }[] = [
		{ key: "full_name", label: "Full Name", span2: true },
		{ key: "first_name", label: "First Name" },
		{ key: "last_name", label: "Last Name" },
		{ key: "relationship", label: "Relationship" },
		{ key: "phone", label: "Phone" },
		{ key: "email", label: "Email" },
		{ key: "address", label: "Address", span2: true },
		{ key: "city", label: "City" },
		{ key: "state", label: "State" },
		{ key: "zip", label: "ZIP" },
	];

	return (
		<div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-3">
			<div className="grid grid-cols-2 gap-2">
				{fields.map(({ key, label, span2 }) => (
					<div key={key} className={span2 ? "col-span-2" : ""}>
						<label className="label pb-0.5">
							<span className="label-text text-xs">{label}</span>
						</label>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							value={
								form[key as keyof typeof form]
							}
							onChange={(e) => update(key, e.target.value)}
						/>
					</div>
				))}
			</div>
			<div className="flex justify-end gap-2">
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className="btn btn-primary btn-xs"
					onClick={handleSave}
					disabled={!form.full_name.trim()}
				>
					{contactId ? "Save" : "Add"}
				</button>
			</div>
		</div>
	);
}

// ─── Section notes ──────────────────────────────────────────────────────────

function SectionNotesFields({
	sectionTitle,
	clientNotes,
	internalNotes,
	onSave,
}: {
	sectionTitle: string;
	clientNotes: string;
	internalNotes: string;
	onSave: (
		section: string,
		noteKind: "client" | "internal",
		value: string,
	) => Promise<void>;
}) {
	const [localClient, setLocalClient] = useState(clientNotes);
	const [localInternal, setLocalInternal] = useState(internalNotes);

	// Sync from props
	const [prevClient, setPrevClient] = useState(clientNotes);
	const [prevInternal, setPrevInternal] = useState(internalNotes);
	if (clientNotes !== prevClient) {
		setPrevClient(clientNotes);
		setLocalClient(clientNotes);
	}
	if (internalNotes !== prevInternal) {
		setPrevInternal(internalNotes);
		setLocalInternal(internalNotes);
	}

	return (
		<div className="mt-2 pt-3 border-t border-base-200 space-y-3">
			<div className="form-control w-full">
				<label className="label pb-1">
					<span className="label-text text-xs text-base-content/50">
						Client Notes
					</span>
				</label>
				<textarea
					className="textarea textarea-bordered textarea-sm w-full min-h-16 text-sm"
					placeholder="Notes from/for the client..."
					value={localClient}
					onChange={(e) => setLocalClient(e.target.value)}
					onBlur={() => {
						if (localClient !== clientNotes) {
							onSave(sectionTitle, "client", localClient);
						}
					}}
				/>
			</div>
			<div className="form-control w-full">
				<label className="label pb-1">
					<span className="label-text text-xs text-base-content/50">
						Internal Notes
					</span>
				</label>
				<textarea
					className="textarea textarea-bordered textarea-sm w-full min-h-16 text-sm"
					placeholder="Internal notes for the legal team..."
					value={localInternal}
					onChange={(e) => setLocalInternal(e.target.value)}
					onBlur={() => {
						if (localInternal !== internalNotes) {
							onSave(sectionTitle, "internal", localInternal);
						}
					}}
				/>
			</div>
		</div>
	);
}

// ─── Question renderers ─────────────────────────────────────────────────────

function QuestionField({
	question,
	value,
	onSave,
}: {
	question: QuestionDef;
	value: string;
	onSave: (name: string, value: string) => Promise<void>;
}) {
	switch (question.kind) {
		case "text":
			return (
				<TextQuestion
					question={question}
					value={value}
					onSave={onSave}
				/>
			);
		case "conditional":
			return (
				<ConditionalQuestion
					question={question}
					value={value}
					onSave={onSave}
				/>
			);
		case "contact-role":
			return <ContactPicker question={question} />;
	}
}

function TextQuestion({
	question,
	value,
	onSave,
}: {
	question: Extract<QuestionDef, { kind: "text" }>;
	value: string;
	onSave: (name: string, value: string) => Promise<void>;
}) {
	const [localValue, setLocalValue] = useState(value);

	// Sync from parent when the prop changes (e.g., after reload)
	const [prevValue, setPrevValue] = useState(value);
	if (value !== prevValue) {
		setPrevValue(value);
		setLocalValue(value);
	}

	const handleBlur = () => {
		if (localValue !== value) {
			onSave(question.variable, localValue);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			(e.target as HTMLInputElement).blur();
		}
	};

	return (
		<div className="form-control w-full">
			<label className="label pb-1">
				<span className="label-text text-sm font-medium flex items-center gap-1.5">
					<span
						className={`inline-block size-2 shrink-0 rounded-full ${localValue.trim() ? "bg-success" : "bg-base-300"}`}
					/>
					{question.label}
				</span>
			</label>
			<input
				type="text"
				className="input input-bordered input-sm w-full"
				placeholder={question.placeholder ?? `Enter ${question.label}`}
				value={localValue}
				onChange={(e) => setLocalValue(e.target.value)}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
			/>
		</div>
	);
}

function ConditionalQuestion({
	question,
	value,
	onSave,
}: {
	question: Extract<QuestionDef, { kind: "conditional" }>;
	value: string;
	onSave: (name: string, value: string) => Promise<void>;
}) {
	const isTrue = value === "true";
	const trueLabel = question.trueLabel ?? "True";
	const falseLabel = question.falseLabel ?? "False";

	return (
		<div className="form-control w-full">
			<label className="label pb-1">
				<span className="label-text text-sm font-medium">
					{question.label}
				</span>
			</label>
			<div className="flex rounded-lg overflow-hidden border border-base-300">
				<button
					type="button"
					className={`flex-1 text-xs font-semibold py-2 transition-colors ${
						isTrue
							? "bg-success text-success-content"
							: "bg-base-200 text-base-content/40 hover:bg-base-300"
					}`}
					onClick={() => onSave(question.variable, "true")}
				>
					{trueLabel}
				</button>
				<button
					type="button"
					className={`flex-1 text-xs font-semibold py-2 transition-colors ${
						!isTrue
							? "bg-error text-error-content"
							: "bg-base-200 text-base-content/40 hover:bg-base-300"
					}`}
					onClick={() => onSave(question.variable, "false")}
				>
					{falseLabel}
				</button>
			</div>
		</div>
	);
}
