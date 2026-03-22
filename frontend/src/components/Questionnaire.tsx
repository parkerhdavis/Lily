import { useMemo, useState } from "react";
import { useWorkflowStore } from "@/stores/workflowStore";
import { questionnaireDef } from "@/data/questionnaireDef";
import type { QuestionDef } from "@/types/questionnaire";

/** Extract just the folder name from a full directory path. */
function getFolderName(dirPath: string): string {
	const segments = dirPath.replace(/\\/g, "/").split("/");
	return segments[segments.length - 1] || dirPath;
}

export default function Questionnaire() {
	const {
		workingDir,
		lilyFile,
		saveClientVariable,
		returnToHub,
	} = useWorkflowStore();

	const variables = lilyFile?.variables ?? {};

	// Track which sections are collapsed
	const [collapsedSections, setCollapsedSections] = useState<
		Record<number, boolean>
	>({});

	const toggleSection = (idx: number) => {
		setCollapsedSections((prev) => ({
			...prev,
			[idx]: !prev[idx],
		}));
	};

	// Compute completion stats
	const stats = useMemo(() => {
		let total = 0;
		let filled = 0;
		for (const section of questionnaireDef) {
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (variables[q.variable]?.trim()) filled++;
				} else if (q.kind === "conditional") {
					// Conditionals are always "filled" (default false)
					// so don't count them in progress
				}
			}
		}
		return { total, filled };
	}, [variables]);

	// Per-section completion
	const sectionStats = useMemo(() => {
		return questionnaireDef.map((section) => {
			let total = 0;
			let filled = 0;
			for (const q of section.questions) {
				if (q.kind === "text") {
					total++;
					if (variables[q.variable]?.trim()) filled++;
				}
			}
			return { total, filled };
		});
	}, [variables]);

	const folderName = workingDir ? getFolderName(workingDir) : "Client";

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
			</div>

			{/* Sections */}
			<div className="flex-1 overflow-y-auto p-6">
				<div className="max-w-2xl mx-auto flex flex-col gap-6">
					{questionnaireDef.map((section, sIdx) => {
						const collapsed = collapsedSections[sIdx] ?? false;
						const ss = sectionStats[sIdx];

						return (
							<div
								key={section.title}
								className="card bg-base-100 border border-base-300 shadow-sm"
							>
								{/* Section header — clickable to collapse */}
								<button
									type="button"
									className="flex items-center gap-3 p-4 w-full text-left hover:bg-base-200/50 transition-colors rounded-t-2xl"
									onClick={() => toggleSection(sIdx)}
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
									{ss.total > 0 && (
										<span className="text-xs text-base-content/40 shrink-0">
											{ss.filled} / {ss.total}
										</span>
									)}
								</button>

								{/* Section body */}
								{!collapsed && (
									<div className="px-4 pb-4 flex flex-col gap-4 border-t border-base-200 pt-4">
										{section.questions.map((q) => (
											<QuestionField
												key={
													q.kind === "contact-role"
														? q.role
														: q.variable
												}
												question={q}
												value={
													q.kind === "contact-role"
														? ""
														: (variables[
																q.variable
															] ?? "")
												}
												onSave={saveClientVariable}
											/>
										))}
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
			// Placeholder — will be implemented in Phase 4
			return (
				<div className="text-sm text-base-content/40 italic">
					Contact role: {question.label} (coming soon)
				</div>
			);
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

	// Sync from parent when the prop changes (e.g., after reload)
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
