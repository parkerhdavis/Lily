export interface AppSettings {
	templates_dir: string | null;
	last_working_dir: string | null;
}

export type WorkflowStep =
	| "select-directory"
	| "select-template"
	| "edit-variables";

/** Metadata for a single document tracked in the sidecar file. */
export interface DocumentMeta {
	template_rel_path: string;
	created_at: string;
	modified_at: string;
	variable_values: Record<string, string>;
}

/** The .lily.json sidecar file stored in each working directory. */
export interface SidecarFile {
	version: number;
	documents: Record<string, DocumentMeta>;
}

/** A node in the template folder tree. */
export type TemplateTreeNode =
	| { kind: "folder"; name: string; children: TemplateTreeNode[] }
	| { kind: "file"; name: string; relPath: string };
