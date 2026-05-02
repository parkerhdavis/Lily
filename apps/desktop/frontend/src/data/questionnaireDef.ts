// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuestionnaireDef } from "@/types/questionnaire";

/**
 * Questionnaire definition.
 *
 * Sections are grouped into tabs: "client-info", "contacts", "assignments".
 * The "Client Contacts" section uses `kind: "contacts"` to render an inline
 * contact management list. All other sections are standard question lists.
 *
 * Each section automatically gets collapsible Client Notes and Internal Notes
 * text areas appended by the Questionnaire component.
 */
export const questionnaireDef: QuestionnaireDef = [
	// ── Tab: Client Info ─────────────────────────────────────────────────
	{
		title: "Client Information",
		tab: "client-info",
		description: "Basic information about the client.",
		questions: [
			{
				kind: "text",
				variable: "Client First Name",
				label: "First Name",
				third: true,
			},
			{
				kind: "text",
				variable: "Client Middle Name",
				label: "Middle Name",
				third: true,
			},
			{
				kind: "text",
				variable: "Client Last Name",
				label: "Last Name",
				third: true,
			},
			{
				kind: "derived",
				variable: "Client Full Name",
				label: "Full Name",
				sources: [
					"Client First Name",
					"Client Middle Name",
					"Client Last Name",
				],
			},
			{
				kind: "text",
				variable: "Client Phone",
				label: "Phone Number",
				placeholder: "e.g. (303) 555-1234",
				half: true,
			},
			{
				kind: "text",
				variable: "Client Email",
				label: "Email Address",
				half: true,
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
				third: true,
			},
			{
				kind: "text",
				variable: "Client State",
				label: "State",
				placeholder: "e.g. CO",
				third: true,
			},
			{
				kind: "text",
				variable: "Client Zip",
				label: "ZIP Code",
				third: true,
			},
			{
				kind: "text",
				variable: "Client County",
				label: "County of Residence",
				placeholder: "e.g. Denver",
			},
		],
	},

	// ── Tab: Contacts ────────────────────────────────────────────────────
	{
		title: "Client Contacts",
		tab: "contacts",
		kind: "contacts",
		description:
			"Add family members, agents, and other contacts associated with the client. " +
			"These contacts can then be selected for roles in the Assignments tab.",
		questions: [],
	},

	// ── Tab: Assignments & Decisions ─────────────────────────────────────
	{
		title: "Healthcare Power of Attorney",
		tab: "assignments",
		description:
			"Designate agents to make healthcare decisions on behalf of the client. " +
			"Used for HPOA and HIPAA documents.",
		questions: [
			{
				kind: "contact-role",
				role: "Primary HPOA Agent",
				label: "Primary HPOA Agent",
				variableMappings: {
					"Primary HPOA Agent Full Name": "full_name",
					"Primary HPOA Agent Phone": "phone",
					"Primary HPOA Agent Address": "address",
					"Primary HPOA Agent City": "city",
					"Primary HPOA Agent State": "state",
					"Primary HPOA Agent Zip": "zip",
				},
				coAgentRole: "Primary HPOA Co-Agent",
				coAgentVariableMappings: {
					"Primary HPOA Co-Agent Full Name": "full_name",
					"Primary HPOA Co-Agent Phone": "phone",
					"Primary HPOA Co-Agent Address": "address",
					"Primary HPOA Co-Agent City": "city",
					"Primary HPOA Co-Agent State": "state",
					"Primary HPOA Co-Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Secondary HPOA Agent",
				label: "Secondary HPOA Agent",
				variableMappings: {
					"Secondary HPOA Agent Full Name": "full_name",
					"Secondary HPOA Agent Phone": "phone",
					"Secondary HPOA Agent Address": "address",
					"Secondary HPOA Agent City": "city",
					"Secondary HPOA Agent State": "state",
					"Secondary HPOA Agent Zip": "zip",
				},
				coAgentRole: "Secondary HPOA Co-Agent",
				coAgentVariableMappings: {
					"Secondary HPOA Co-Agent Full Name": "full_name",
					"Secondary HPOA Co-Agent Phone": "phone",
					"Secondary HPOA Co-Agent Address": "address",
					"Secondary HPOA Co-Agent City": "city",
					"Secondary HPOA Co-Agent State": "state",
					"Secondary HPOA Co-Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Tertiary HPOA Agent",
				label: "Tertiary HPOA Agent",
				variableMappings: {
					"Tertiary HPOA Agent Full Name": "full_name",
					"Tertiary HPOA Agent Phone": "phone",
					"Tertiary HPOA Agent Address": "address",
					"Tertiary HPOA Agent City": "city",
					"Tertiary HPOA Agent State": "state",
					"Tertiary HPOA Agent Zip": "zip",
				},
				coAgentRole: "Tertiary HPOA Co-Agent",
				coAgentVariableMappings: {
					"Tertiary HPOA Co-Agent Full Name": "full_name",
					"Tertiary HPOA Co-Agent Phone": "phone",
					"Tertiary HPOA Co-Agent Address": "address",
					"Tertiary HPOA Co-Agent City": "city",
					"Tertiary HPOA Co-Agent State": "state",
					"Tertiary HPOA Co-Agent Zip": "zip",
				},
			},
		],
	},
	{
		title: "Financial Power of Attorney",
		tab: "assignments",
		description:
			"Designate agents to manage financial matters on behalf of the client. " +
			"Used for General POA (GPOA) documents.",
		questions: [
			{
				kind: "contact-role",
				role: "Primary FPOA Agent",
				label: "Primary FPOA Agent",
				variableMappings: {
					"Primary FPOA Agent Full Name": "full_name",
					"Primary FPOA Agent Phone": "phone",
					"Primary FPOA Agent Address": "address",
					"Primary FPOA Agent City": "city",
					"Primary FPOA Agent State": "state",
					"Primary FPOA Agent Zip": "zip",
				},
				coAgentRole: "Primary FPOA Co-Agent",
				coAgentVariableMappings: {
					"Primary FPOA Co-Agent Full Name": "full_name",
					"Primary FPOA Co-Agent Phone": "phone",
					"Primary FPOA Co-Agent Address": "address",
					"Primary FPOA Co-Agent City": "city",
					"Primary FPOA Co-Agent State": "state",
					"Primary FPOA Co-Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Secondary FPOA Agent",
				label: "Secondary FPOA Agent",
				variableMappings: {
					"Secondary FPOA Agent Full Name": "full_name",
					"Secondary FPOA Agent Phone": "phone",
					"Secondary FPOA Agent Address": "address",
					"Secondary FPOA Agent City": "city",
					"Secondary FPOA Agent State": "state",
					"Secondary FPOA Agent Zip": "zip",
				},
				coAgentRole: "Secondary FPOA Co-Agent",
				coAgentVariableMappings: {
					"Secondary FPOA Co-Agent Full Name": "full_name",
					"Secondary FPOA Co-Agent Phone": "phone",
					"Secondary FPOA Co-Agent Address": "address",
					"Secondary FPOA Co-Agent City": "city",
					"Secondary FPOA Co-Agent State": "state",
					"Secondary FPOA Co-Agent Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Tertiary FPOA Agent",
				label: "Tertiary FPOA Agent",
				variableMappings: {
					"Tertiary FPOA Agent Full Name": "full_name",
					"Tertiary FPOA Agent Phone": "phone",
					"Tertiary FPOA Agent Address": "address",
					"Tertiary FPOA Agent City": "city",
					"Tertiary FPOA Agent State": "state",
					"Tertiary FPOA Agent Zip": "zip",
				},
				coAgentRole: "Tertiary FPOA Co-Agent",
				coAgentVariableMappings: {
					"Tertiary FPOA Co-Agent Full Name": "full_name",
					"Tertiary FPOA Co-Agent Phone": "phone",
					"Tertiary FPOA Co-Agent Address": "address",
					"Tertiary FPOA Co-Agent City": "city",
					"Tertiary FPOA Co-Agent State": "state",
					"Tertiary FPOA Co-Agent Zip": "zip",
				},
			},
		],
	},
	{
		title: "Personal Representatives",
		tab: "assignments",
		description: "Designate personal representatives for the client's will.",
		questions: [
			{
				kind: "contact-role",
				role: "Primary Personal Representative",
				label: "Primary Personal Representative",
				variableMappings: {
					"Primary Personal Representative Full Name": "full_name",
					"Primary Personal Representative Phone": "phone",
					"Primary Personal Representative Address": "address",
					"Primary Personal Representative City": "city",
					"Primary Personal Representative State": "state",
					"Primary Personal Representative Zip": "zip",
				},
				coAgentRole: "Primary Co-Personal Representative",
				coAgentVariableMappings: {
					"Primary Co-Personal Representative Full Name": "full_name",
					"Primary Co-Personal Representative Phone": "phone",
					"Primary Co-Personal Representative Address": "address",
					"Primary Co-Personal Representative City": "city",
					"Primary Co-Personal Representative State": "state",
					"Primary Co-Personal Representative Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Secondary Personal Representative",
				label: "Secondary Personal Representative",
				variableMappings: {
					"Secondary Personal Representative Full Name": "full_name",
					"Secondary Personal Representative Phone": "phone",
					"Secondary Personal Representative Address": "address",
					"Secondary Personal Representative City": "city",
					"Secondary Personal Representative State": "state",
					"Secondary Personal Representative Zip": "zip",
				},
				coAgentRole: "Secondary Co-Personal Representative",
				coAgentVariableMappings: {
					"Secondary Co-Personal Representative Full Name": "full_name",
					"Secondary Co-Personal Representative Phone": "phone",
					"Secondary Co-Personal Representative Address": "address",
					"Secondary Co-Personal Representative City": "city",
					"Secondary Co-Personal Representative State": "state",
					"Secondary Co-Personal Representative Zip": "zip",
				},
			},
			{
				kind: "contact-role",
				role: "Tertiary Personal Representative",
				label: "Tertiary Personal Representative",
				variableMappings: {
					"Tertiary Personal Representative Full Name": "full_name",
					"Tertiary Personal Representative Phone": "phone",
					"Tertiary Personal Representative Address": "address",
					"Tertiary Personal Representative City": "city",
					"Tertiary Personal Representative State": "state",
					"Tertiary Personal Representative Zip": "zip",
				},
				coAgentRole: "Tertiary Co-Personal Representative",
				coAgentVariableMappings: {
					"Tertiary Co-Personal Representative Full Name": "full_name",
					"Tertiary Co-Personal Representative Phone": "phone",
					"Tertiary Co-Personal Representative Address": "address",
					"Tertiary Co-Personal Representative City": "city",
					"Tertiary Co-Personal Representative State": "state",
					"Tertiary Co-Personal Representative Zip": "zip",
				},
			},
		],
	},
	{
		title: "Guardians",
		tab: "assignments",
		description:
			"Designate guardians for minor children. Only applies if the " +
			"client has minor children.",
		questions: [
			{
				kind: "contact-role",
				role: "Primary Guardian",
				label: "Primary Guardian",
				variableMappings: {
					"Primary Guardian Full Name": "full_name",
				},
			},
			{
				kind: "contact-role",
				role: "Secondary Guardian",
				label: "Secondary Guardian",
				variableMappings: {
					"Secondary Guardian Full Name": "full_name",
				},
			},
		],
	},
	{
		title: "Beneficiaries",
		tab: "assignments",
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
				role: "Secondary Beneficiary",
				label: "Secondary Beneficiary",
				variableMappings: {
					"Secondary Beneficiary Full Name": "full_name",
					"Secondary Beneficiary Relationship": "relationship",
				},
			},
		],
	},
	{
		title: "Property Distribution",
		tab: "assignments",
		description: "Specify recipients for tangible personal property.",
		questions: [
			{
				kind: "text",
				variable: "Tangible Property Recipient(s)",
				label: "Tangible Property Recipient(s)",
				placeholder: "e.g. my children, in equal shares",
			},
		],
	},
	{
		title: "Trust & Trustees",
		tab: "assignments",
		description:
			"Configure the family trust name and designate trustees to manage " +
			"the trust upon the client's death or disability.",
		questions: [
			{
				kind: "text",
				variable: "Pour-Over Trust Name",
				label: "Family Trust Name",
				placeholder: "e.g. The Smith Family Trust",
			},
			{
				kind: "contact-role",
				role: "Primary Trustee",
				label: "Primary Trustee",
				variableMappings: {
					"Primary Trustee Full Name": "full_name",
				},
			},
			{
				kind: "contact-role",
				role: "Secondary Trustee",
				label: "Secondary Trustee",
				variableMappings: {
					"Secondary Trustee Full Name": "full_name",
				},
			},
			{
				kind: "contact-role",
				role: "Tertiary Trustee",
				label: "Tertiary Trustee",
				variableMappings: {
					"Tertiary Trustee Full Name": "full_name",
				},
			},
		],
	},
];

/** Tab definitions for the questionnaire. */
export const questionnaireTabs = [
	{ id: "client-info" as const, label: "Client Info" },
	{ id: "contacts" as const, label: "Client Contacts" },
	{ id: "assignments" as const, label: "Assignments & Decisions" },
];
