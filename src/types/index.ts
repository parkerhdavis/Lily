export interface AppSettings {
	templates_dir: string | null;
	last_working_dir: string | null;
}

export type WorkflowStep =
	| "select-directory"
	| "select-template"
	| "edit-variables";

/** Metadata for a single document tracked in the .lily project file. */
export interface DocumentMeta {
	template_rel_path: string;
	created_at: string;
	modified_at: string;
}

/** The .lily project file stored in each client/working directory. */
export interface LilyFile {
	lily_version: number;
	/** Client-level variable values shared across all documents. */
	variables: Record<string, string>;
	/** Map from document filename to its metadata. */
	documents: Record<string, DocumentMeta>;
}

/** Info about a single logical variable, with case-variant grouping. */
export interface VariableInfo {
	/** Display name shown in the UI (title-case preferred). */
	display_name: string;
	/** All distinct casings found in the document for this variable. */
	variants: string[];
}

/** A node in the template folder tree. */
export type TemplateTreeNode =
	| { kind: "folder"; name: string; children: TemplateTreeNode[] }
	| { kind: "file"; name: string; relPath: string };
