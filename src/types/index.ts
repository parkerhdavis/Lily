export interface AppSettings {
	templates_dir: string | null;
	last_working_dir: string | null;
}

export type WorkflowStep =
	| "select-directory"
	| "select-template"
	| "edit-variables";
