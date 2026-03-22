import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { questionnaireDef, questionnaireTabs } from "@/data/questionnaireDef";
import ContactPicker from "@/components/ContactPicker";
import type { QuestionDef } from "@/types/questionnaire";

/** Extract just the folder name from a full directory path. */
function getFolderName(dirPath: string): string {
	const segments = dirPath.replace(/\\/g, "/").split("/");
	return segments[segments.length - 1] || dirPath;
}

type TabId = (typeof questionnaireTabs)[number]["id"];

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

	// Tab state
	const [activeTab, setActiveTab] = useState<TabId>("client-info");

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

	const handleSaveVariable = useCallback(
		async (name: string, value: string) => {
			setSaveStatus("saving");
			await saveClientVariable(name, value);
			showSaved();
		},
		[saveClientVariable, showSaved],
	);

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

	// Wrap contact ops to trigger save indicator
	const handleAddContact = useCallback(
		async (contact: Omit<import("@/types").Contact, "id">) => {
			setSaveStatus("saving");
			const result = await addContact(contact);
			showSaved();
			return result;
		},
		[addContact, showSaved],
	);

	const handleUpdateContact = useCallback(
		async (contact: import("@/types").Contact) => {
			setSaveStatus("saving");
			await updateContact(contact);
			showSaved();
		},
		[updateContact, showSaved],
	);

	const handleDeleteContact = useCallback(
		async (contactId: string) => {
			setSaveStatus("saving");
			await deleteContact(contactId);
			showSaved();
		},
		[deleteContact, showSaved],
	);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, []);

	// Sections for the active tab
	const tabSections = useMemo(
		() => questionnaireDef.filter((s) => s.tab === activeTab),
		[activeTab],
	);

	// All sections start collapsed
	const [collapsedSections, setCollapsedSections] = useState<
		Record<string, boolean>
	>(() => {
		const init: Record<string, boolean> = {};
		for (const s of questionnaireDef) {
			init[s.title] = true;
		}
		return init;
	});

	const toggleSection = (title: string) => {
		setCollapsedSections((prev) => ({
			...prev,
			[title]: !prev[title],
		}));
	};

	const expandAll = () => {
		setCollapsedSections((prev) => {
			const next = { ...prev };
			for (const s of tabSections) next[s.title] = false;
			return next;
		});
	};

	const collapseAll = () => {
		setCollapsedSections((prev) => {
			const next = { ...prev };
			for (const s of tabSections) next[s.title] = true;
			return next;
		});
	};

	// Search
	const [search, setSearch] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	// Ctrl+F to focus search
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "f") {
				e.preventDefault();
				searchRef.current?.focus();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	// Filter sections by search query
	const filteredSections = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return tabSections;

		const tokens = q.split(/\s+/);
		return tabSections.filter((section) => {
			// Match section title
			if (
				tokens.every((t) => section.title.toLowerCase().includes(t))
			)
				return true;
			// Match question labels or variable names
			return section.questions.some((question) => {
				const label =
					question.kind === "contact-role"
						? question.label
						: question.kind === "text"
							? `${question.label} ${question.variable}`
							: question.label;
				return tokens.every((t) =>
					label.toLowerCase().includes(t),
				);
			});
		});
	}, [tabSections, search]);

	// Auto-expand sections that match search
	useEffect(() => {
		if (search.trim()) {
			setCollapsedSections((prev) => {
				const next = { ...prev };
				for (const s of filteredSections) next[s.title] = false;
				return next;
			});
		}
	}, [filteredSections, search]);

	// Completion stats
	const stats = useMemo(() => {
		let total = 0;
		let filled = 0;
		for (const section of questionnaireDef) {
			if (section.kind === "contacts") {
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

	// Per-section stats
	const sectionStats = useMemo(() => {
		const map: Record<string, { total: number; filled: number; label: string | null }> = {};
		for (const section of questionnaireDef) {
			if (section.kind === "contacts") {
				map[section.title] = {
					total: 1,
					filled: contacts.length > 0 ? 1 : 0,
					label: `${contacts.length} contact${contacts.length !== 1 ? "s" : ""}`,
				};
				continue;
			}
			let total = 0;
			let filled = 0;
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (variables[q.variable]?.trim()) filled++;
				}
			}
			map[section.title] = { total, filled, label: null };
		}
		return map;
	}, [variables, contacts]);

	const folderName = workingDir ? getFolderName(workingDir) : "Client";

	const allExpanded = tabSections.every(
		(s) => !collapsedSections[s.title],
	);

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
				<div className="text-xs w-28 text-right">
					{saveStatus === "saving" && (
						<span className="text-warning flex items-center justify-end gap-1">
							<span className="loading loading-spinner loading-xs" />
							Saving...
						</span>
					)}
					{saveStatus === "saved" && (
						<span className="text-success">
							All changes saved
						</span>
					)}
				</div>
			</div>

			{/* Tab bar — sticky below header */}
			<div className="sticky top-0 z-10 bg-base-100 border-b border-base-300">
				<div className="flex">
					{questionnaireTabs.map((tab) => (
						<button
							key={tab.id}
							type="button"
							className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
								activeTab === tab.id
									? "border-primary text-primary"
									: "border-transparent text-base-content/50 hover:text-base-content/80 hover:bg-base-200/50"
							}`}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>
			</div>

			{/* Controls bar */}
			<div className="flex items-center gap-2 px-6 py-2 bg-base-100 border-b border-base-200">
				<input
					ref={searchRef}
					type="text"
					className="input input-bordered input-xs flex-1 max-w-xs"
					placeholder="Search fields... (Ctrl+F)"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={allExpanded ? collapseAll : expandAll}
				>
					{allExpanded ? "Collapse All" : "Expand All"}
				</button>
			</div>

			{/* Sections */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-2xl mx-auto flex flex-col gap-6">
					{filteredSections.length === 0 && search && (
						<p className="text-sm text-base-content/50 text-center py-8">
							No fields match your search.
						</p>
					)}

					{filteredSections.map((section) => {
						const collapsed =
							collapsedSections[section.title] ?? true;
						const ss = sectionStats[section.title];
						const isContacts = section.kind === "contacts";

						return (
							<div
								key={section.title}
								className="card bg-base-100 border border-base-300 shadow-sm"
							>
								{/* Section header */}
								<button
									type="button"
									className="flex items-center gap-3 p-4 w-full text-left hover:bg-base-200/50 transition-colors rounded-t-2xl"
									onClick={() =>
										toggleSection(section.title)
									}
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
									{ss && (
										<span className="text-xs text-base-content/40 shrink-0">
											{ss.label ??
												(ss.total > 0
													? `${ss.filled} / ${ss.total}`
													: "")}
										</span>
									)}
								</button>

								{/* Section body */}
								{!collapsed && (
									<div className="px-4 pb-4 border-t border-base-200 pt-4">
										{isContacts ? (
											<InlineContactList
												contacts={contacts}
												onAdd={handleAddContact}
												onUpdate={handleUpdateContact}
												onDelete={handleDeleteContact}
											/>
										) : (
											<div className="grid grid-cols-6 gap-x-3 gap-y-4">
												{section.questions.map(
													(q) => {
														const span =
															q.kind ===
																"text" &&
															q.third
																? "col-span-2"
																: q.kind ===
																		"text" &&
																	q.half
																	? "col-span-3"
																	: "col-span-6";
														return (
															<div
																key={
																	q.kind ===
																	"contact-role"
																		? q.role
																		: q.variable
																}
																className={
																	span
																}
															>
																<QuestionField
																	question={
																		q
																	}
																	value={
																		q.kind ===
																		"contact-role"
																			? ""
																			: (variables[
																					q.variable
																				] ??
																				"")
																	}
																	onSave={
																		handleSaveVariable
																	}
																/>
															</div>
														);
													},
												)}
											</div>
										)}

										{/* Notes (collapsible) */}
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

// ─── Inline contact list ────────────────────────────────────────────────────

function InlineContactList({
	contacts,
	onAdd,
	onUpdate,
	onDelete,
}: {
	contacts: {
		id: string;
		full_name: string;
		relationship: string;
		phone: string;
		email: string;
	}[];
	onAdd: (
		contact: Omit<import("@/types").Contact, "id">,
	) => Promise<import("@/types").Contact>;
	onUpdate: (contact: import("@/types").Contact) => Promise<void>;
	onDelete: (contactId: string) => Promise<void>;
}) {
	const [editingId, setEditingId] = useState<string | null>(null);

	const handleAdd = async () => {
		// Immediately create an empty contact and open it for editing
		const created = await onAdd({
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
		});
		setEditingId(created.id);
	};

	return (
		<div className="space-y-3">
			{contacts.length === 0 && editingId === null && (
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

			<button
				type="button"
				className="btn btn-outline btn-sm w-full"
				onClick={handleAdd}
			>
				+ Add Contact
			</button>
		</div>
	);
}

/** Inline form for editing a contact with side-by-side fields.
 *  Auto-saves each field on blur. */
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

	// Track the last-saved snapshot to avoid redundant saves
	const savedRef = useRef({ ...form });

	const update = (key: string, value: string) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const handleFieldBlur = useCallback(async () => {
		// Save if anything changed since last save
		const current = form;
		const saved = savedRef.current;
		const changed = Object.keys(current).some(
			(k) =>
				current[k as keyof typeof current] !==
				saved[k as keyof typeof saved],
		);
		if (changed) {
			savedRef.current = { ...current };
			await onSave({ id: contactId ?? "", ...current });
		}
	}, [form, contactId, onSave]);

	const fields: {
		key: string;
		label: string;
		span: 6 | 3 | 2;
	}[] = [
		{ key: "first_name", label: "First Name", span: 3 },
		{ key: "last_name", label: "Last Name", span: 3 },
		{ key: "full_name", label: "Full Legal Name", span: 6 },
		{ key: "relationship", label: "Relationship", span: 6 },
		{ key: "phone", label: "Phone", span: 3 },
		{ key: "email", label: "Email", span: 3 },
		{ key: "address", label: "Address", span: 6 },
		{ key: "city", label: "City", span: 2 },
		{ key: "state", label: "State", span: 2 },
		{ key: "zip", label: "ZIP", span: 2 },
	];

	return (
		<div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-3">
			<div className="grid grid-cols-6 gap-2">
				{fields.map(({ key, label, span }) => (
					<div
						key={key}
						className={
							span === 6
								? "col-span-6"
								: span === 3
									? "col-span-3"
									: "col-span-2"
						}
					>
						<label className="label pb-0.5">
							<span className="label-text text-xs">
								{label}
							</span>
						</label>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							value={form[key as keyof typeof form]}
							onChange={(e) => update(key, e.target.value)}
							onBlur={handleFieldBlur}
						/>
					</div>
				))}
			</div>
			<div className="flex justify-end">
				<button
					type="button"
					className="btn btn-ghost btn-xs"
					onClick={onCancel}
				>
					Done
				</button>
			</div>
		</div>
	);
}

// ─── Section notes (collapsible) ────────────────────────────────────────────

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
	const hasNotes = Boolean(clientNotes || internalNotes);
	const [open, setOpen] = useState(hasNotes);

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
		<div className="mt-3 pt-3 border-t border-base-200">
			<button
				type="button"
				className="text-xs text-base-content/40 hover:text-base-content/60 transition-colors flex items-center gap-1"
				onClick={() => setOpen(!open)}
			>
				<span
					className={`transition-transform ${open ? "rotate-90" : ""}`}
				>
					&#9654;
				</span>
				Notes
				{hasNotes && (
					<span className="inline-block size-1.5 rounded-full bg-primary/50" />
				)}
			</button>
			{open && (
				<div className="mt-2 space-y-3">
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
									onSave(
										sectionTitle,
										"client",
										localClient,
									);
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
							onChange={(e) =>
								setLocalInternal(e.target.value)
							}
							onBlur={() => {
								if (localInternal !== internalNotes) {
									onSave(
										sectionTitle,
										"internal",
										localInternal,
									);
								}
							}}
						/>
					</div>
				</div>
			)}
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
