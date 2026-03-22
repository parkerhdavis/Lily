import type { QuestionnaireDef } from "@/types/questionnaire";

/**
 * Placeholder questionnaire definition.
 *
 * Each section contains questions that map to client-level variables in the
 * .lily file. Text questions produce replacement variables; conditional
 * questions produce boolean toggles; contact-role questions (Phase 4) will
 * allow selecting a contact to auto-fill multiple variables at once.
 *
 * Replace / expand these sections with the real questionnaire content once
 * the form structure is finalized.
 */
export const questionnaireDef: QuestionnaireDef = [
	{
		title: "Client Information",
		description: "Basic information about the client.",
		questions: [
			{
				kind: "text",
				variable: "Client Full Name",
				label: "Full Legal Name",
				placeholder: "e.g. Jane M. Doe",
			},
			{
				kind: "text",
				variable: "Client First Name",
				label: "First Name",
			},
			{
				kind: "text",
				variable: "Client Last Name",
				label: "Last Name",
			},
			{
				kind: "text",
				variable: "Client Phone",
				label: "Phone Number",
				placeholder: "e.g. (303) 555-1234",
			},
			{
				kind: "text",
				variable: "Client Email",
				label: "Email Address",
			},
			{
				kind: "text",
				variable: "Client Address",
				label: "Street Address",
			},
			{
				kind: "text",
				variable: "Client City",
				label: "City",
			},
			{
				kind: "text",
				variable: "Client State",
				label: "State",
				placeholder: "e.g. CO",
			},
			{
				kind: "text",
				variable: "Client Zip",
				label: "ZIP Code",
			},
		],
	},
	{
		title: "Spouse / Partner",
		description:
			"If the client has a spouse or partner, fill in their details here.",
		questions: [
			{
				kind: "conditional",
				variable: "Client Is Married",
				label: "Is the client married or partnered?",
				trueLabel: "Yes",
				falseLabel: "No",
			},
			{
				kind: "text",
				variable: "Spouse Full Name",
				label: "Spouse Full Legal Name",
			},
			{
				kind: "text",
				variable: "Spouse First Name",
				label: "Spouse First Name",
			},
			{
				kind: "text",
				variable: "Spouse Last Name",
				label: "Spouse Last Name",
			},
			{
				kind: "text",
				variable: "Spouse Phone",
				label: "Spouse Phone Number",
			},
			{
				kind: "text",
				variable: "Spouse Email",
				label: "Spouse Email Address",
			},
		],
	},
	{
		title: "Estate Planning Basics",
		description: "General estate planning preferences.",
		questions: [
			{
				kind: "text",
				variable: "County",
				label: "County of Residence",
				placeholder: "e.g. Denver County",
			},
			{
				kind: "conditional",
				variable: "Has Children",
				label: "Does the client have children?",
				trueLabel: "Yes",
				falseLabel: "No",
			},
			{
				kind: "text",
				variable: "Number of Children",
				label: "Number of Children",
			},
		],
	},
];
