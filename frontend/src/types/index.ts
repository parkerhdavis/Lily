export interface AppSettings {
	templates_dir: string | null;
	last_working_dir: string | null;
}

export type WorkflowStep =
	| "select-directory"
	| "client-hub"
	| "select-template"
	| "edit-variables";

/** Metadata for a single document tracked in the .lily project file. */
export interface DocumentMeta {
	template_rel_path: string;
	created_at: string;
	modified_at: string;
	/** Display names of variables this document uses. Recorded when the
	 *  template is first processed so the variable list survives after
	 *  placeholders are replaced with real values in the docx. */
	variable_names: string[];
}

/** The .lily project file stored in each client/working directory. */
export interface LilyFile {
	lily_version: number;
	/** Client-level variable values shared across all documents. */
	variables: Record<string, string>;
	/** Display names of conditional (ternary) variables that render as
	 *  checkboxes. */
	conditional_variables: string[];
	/** Map from document filename to its metadata. */
	documents: Record<string, DocumentMeta>;
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
