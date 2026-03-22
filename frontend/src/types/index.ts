export interface AppSettings {
	templates_dir: string | null;
	last_working_dir: string | null;
	recent_directories: string[];
	window_width: number | null;
	window_height: number | null;
	theme: string | null;
	zoom: number | null;
	footer_size: string | null;
}

export type WorkflowStep =
	| "hub"
	| "client-hub"
	| "questionnaire"
	| "select-template"
	| "edit-variables"
	| "app-settings"
	| "pipeline";

/** A per-document override for a contact role. */
export interface RoleOverride {
	/** The contact ID for this override, or null for custom manual values. */
	contact_id: string | null;
	/** The specific variable values for this override. */
	values: Record<string, string>;
}

/** Metadata for a single document tracked in the .lily project file. */
export interface DocumentMeta {
	template_rel_path: string;
	created_at: string;
	modified_at: string;
	/** Display names of variables this document uses. Recorded when the
	 *  template is first processed so the variable list survives after
	 *  placeholders are replaced with real values in the docx. */
	variable_names: string[];
	/** Per-document role overrides (roles that diverge from the questionnaire). */
	role_overrides: Record<string, RoleOverride>;
}

/** A contact associated with a client (family member, agent, trustee, etc.). */
export interface Contact {
	id: string;
	full_name: string;
	first_name: string;
	last_name: string;
	relationship: string;
	phone: string;
	email: string;
	address: string;
	city: string;
	state: string;
	zip: string;
}

/** Maps a role (e.g., "Healthcare POA Agent") to a contact and defines which
 *  variables auto-fill from which contact properties. */
export interface ContactBinding {
	/** The contact ID bound to this role, or null for manual ("Other") entry. */
	contact_id: string | null;
	/** Map from variable display name to contact property key. */
	variable_mappings: Record<string, string>;
}

/** The .lily project file stored in each client/working directory. */
export interface LilyFile {
	lily_version: number;
	/** Client-level variable values shared across all documents. */
	variables: Record<string, string>;
	/** Display names of conditional (ternary) variables that render as
	 *  toggles. */
	conditional_variables: string[];
	/** Full conditional definitions keyed by display name.  Each entry
	 *  holds every distinct `"Label ?? true_text :: false_text"` string
	 *  found in the template(s) for that label. */
	conditional_definitions: Record<string, string[]>;
	/** Map from document filename to its metadata. */
	documents: Record<string, DocumentMeta>;
	/** Contacts associated with this client. */
	contacts: Contact[];
	/** Contact-to-role bindings, keyed by role name. */
	contact_bindings: Record<string, ContactBinding>;
	/** Questionnaire notes keyed by section title. */
	questionnaire_notes: Record<string, SectionNotes>;
}

/** Notes attached to a questionnaire section. */
export interface SectionNotes {
	/** Notes from/for the client (visible in client-facing tools). */
	client: string;
	/** Internal notes for the legal team (not visible to clients). */
	internal: string;
}

/** Info about a single logical variable, with case-variant grouping. */
export interface VariableInfo {
	/** Display name shown in the UI (title-case preferred).
	 *  For conditional variables, this is the label portion (before `??`). */
	display_name: string;
	/** All distinct casings found in the document for this variable. */
	variants: string[];
	/** Whether this is a conditional (ternary) variable that renders as a
	 *  checkbox. Conditional variables use `{Label ?? true_text :: false_text}`
	 *  syntax and store `"true"` / `"false"` as their value. */
	is_conditional: boolean;
}

/** A node in the template folder tree. */
export type TemplateTreeNode =
	| { kind: "folder"; name: string; children: TemplateTreeNode[] }
	| { kind: "file"; name: string; relPath: string };
