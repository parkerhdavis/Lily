/** A single question in the questionnaire. */
export type QuestionDef =
	| {
			kind: "text";
			/** The variable name this question populates. */
			variable: string;
			/** Human-readable label shown in the form. */
			label: string;
			/** Optional placeholder text. */
			placeholder?: string;
			/** If true, this field takes half width (for side-by-side layouts). */
			half?: boolean;
			/** If set, this field takes 1/3 width. */
			third?: boolean;
	  }
	| {
			kind: "conditional";
			/** The conditional variable name. */
			variable: string;
			label: string;
			/** Descriptive text for the "true" state. */
			trueLabel?: string;
			/** Descriptive text for the "false" state. */
			falseLabel?: string;
	  }
	| {
			kind: "contact-role";
			/** The role name (e.g., "Healthcare POA Agent"). Used as the key
			 *  in the contact_bindings map. */
			role: string;
			label: string;
			/** Map from variable display name to contact property key.
			 *  Defines which variables auto-fill from the selected contact. */
			variableMappings: Record<string, string>;
	  };

/** A section grouping related questions.
 *
 *  Sections with `kind: "contacts"` render an inline contact list instead
 *  of iterating over `questions` (which should be empty for those sections). */
export interface QuestionnaireSectionDef {
	title: string;
	description?: string;
	/** Section kind. Defaults to `"standard"` if omitted. */
	kind?: "standard" | "contacts";
	/** Which tab this section belongs to. */
	tab: "client-info" | "contacts" | "assignments";
	questions: QuestionDef[];
}

/** The full questionnaire definition — an ordered list of sections. */
export type QuestionnaireDef = QuestionnaireSectionDef[];

// ─── Persisted questionnaire types ──────────────────────────────────────────

/** A complete questionnaire definition file stored on disk. */
export interface QuestionnaireDefFile {
	id: string;
	name: string;
	version: number;
	tabs: { id: string; label: string }[];
	sections: QuestionnaireSectionDef[];
}

/** An entry in the questionnaire index (metadata only). */
export interface QuestionnaireIndexEntry {
	id: string;
	name: string;
	version: number;
	created_at: string;
	modified_at: string;
}

/** The questionnaire index — lists all definitions and which is active. */
export interface QuestionnaireIndex {
	questionnaires: QuestionnaireIndexEntry[];
	active_questionnaire_id: string | null;
}
