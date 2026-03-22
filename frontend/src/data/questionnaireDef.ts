import type { QuestionnaireDef } from "@/types/questionnaire";

/**
 * Questionnaire definition.
 *
 * Each section contains questions that map to client-level variables in the
 * .lily file. The "Client Contacts" section uses `kind: "contacts"` to render
 * an inline contact management list. All other sections are standard question
 * lists with text inputs, conditional toggles, and contact-role pickers.
 *
 * Each section automatically gets Client Notes and Internal Notes text areas
 * appended by the Questionnaire component — those are not defined here.
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
			{
				kind: "text",
				variable: "County",
				label: "County of Residence",
				placeholder: "e.g. Denver County",
			},
		],
	},
	{
		title: "Client Contacts",
		kind: "contacts",
		description:
			"Add family members, agents, and other contacts associated with the client. " +
			"These contacts can then be selected for roles in the sections below.",
		questions: [],
	},
	{
		title: "Healthcare Power of Attorney",
		description:
			"Designate agents to make healthcare decisions on behalf of the client. " +
			"Used for HPOA and HIPAA documents.",
		questions: [
			{
				kind: "contact-role",
				role: "Healthcare POA Agent",
				label: "Primary Healthcare POA Agent",
				variableMappings: {
					"Healthcare POA Agent Full Name": "full_name",
					"Healthcare POA Agent Phone": "phone",
					"Healthcare POA Agent Address": "address",
					"Healthcare POA Agent City": "city",
					"Healthcare POA Agent State": "state",
					"Healthcare POA Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Healthcare POA Alternate Agent",
				label: "Alternate Healthcare POA Agent",
				variableMappings: {
					"Healthcare POA Alternate Full Name": "full_name",
					"Healthcare POA Alternate Phone": "phone",
					"Healthcare POA Alternate Address": "address",
					"Healthcare POA Alternate City": "city",
					"Healthcare POA Alternate State": "state",
					"Healthcare POA Alternate Zip": "zip",
				},
			},
		],
	},
	{
		title: "Financial Power of Attorney",
		description:
			"Designate agents to manage financial matters on behalf of the client. " +
			"Used for General POA (GPOA) documents.",
		questions: [
			{
				kind: "contact-role",
				role: "Financial POA Agent",
				label: "Primary Financial POA Agent",
				variableMappings: {
					"Financial POA Agent Full Name": "full_name",
					"Financial POA Agent Phone": "phone",
					"Financial POA Agent Address": "address",
					"Financial POA Agent City": "city",
					"Financial POA Agent State": "state",
					"Financial POA Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Financial POA Alternate Agent",
				label: "Alternate Financial POA Agent",
				variableMappings: {
					"Financial POA Alternate Full Name": "full_name",
					"Financial POA Alternate Phone": "phone",
					"Financial POA Alternate Address": "address",
					"Financial POA Alternate City": "city",
					"Financial POA Alternate State": "state",
					"Financial POA Alternate Zip": "zip",
				},
			},
		],
	},
	{
		title: "Personal Representatives",
		description:
			"Designate personal representatives for the client's will.",
		questions: [
			{
				kind: "contact-role",
				role: "Personal Representative",
				label: "Primary Personal Representative",
				variableMappings: {
					"Personal Representative Full Name": "full_name",
					"Personal Representative Phone": "phone",
					"Personal Representative Address": "address",
					"Personal Representative City": "city",
					"Personal Representative State": "state",
					"Personal Representative Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Alternate Personal Representative",
				label: "Alternate Personal Representative",
				variableMappings: {
					"Alternate Personal Representative Full Name": "full_name",
					"Alternate Personal Representative Phone": "phone",
					"Alternate Personal Representative Address": "address",
					"Alternate Personal Representative City": "city",
					"Alternate Personal Representative State": "state",
					"Alternate Personal Representative Zip": "zip",
				},
			},
		],
	},
	{
		title: "Beneficiaries",
		description: "Designate beneficiaries for the client's will.",
		questions: [
			{
				kind: "contact-role",
				role: "Primary Beneficiary",
				label: "Primary Beneficiary",
				variableMappings: {
					"Primary Beneficiary Full Name": "full_name",
					"Primary Beneficiary Relationship": "relationship",
				},
			},
			{
				kind: "contact-role",
				role: "Alternate Beneficiary",
				label: "Alternate Beneficiary",
				variableMappings: {
					"Alternate Beneficiary Full Name": "full_name",
					"Alternate Beneficiary Relationship": "relationship",
				},
			},
		],
	},
];
