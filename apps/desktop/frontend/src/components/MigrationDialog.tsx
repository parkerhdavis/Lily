import { useCallback, useMemo, useState } from "react";

/** A variable in the client's .lily file that has no home in the current questionnaire. */
export interface OrphanedVariable {
	name: string;
	value: string;
}

/** Result of comparing client variables against the current questionnaire. */
export interface MigrationReport {
	/** Variables with values that aren't used by the questionnaire or any document. */
	orphaned: OrphanedVariable[];
	/** Questionnaire variables that have no value in the .lily file. */
	unfilled: string[];
	/** Current questionnaire version to stamp after migration. */
	currentVersion: number;
}

/** A mapping from an orphaned variable to a target questionnaire variable. */
export interface FieldMapping {
	from: string;
	to: string;
}

// ─── String similarity ──────────────────────────────────────────────────

/** Token-overlap similarity score between two variable names (0–1). */
function similarity(a: string, b: string): number {
	const tokensA = a.toLowerCase().split(/\s+/);
	const tokensB = b.toLowerCase().split(/\s+/);
	const common = tokensA.filter((t) => tokensB.includes(t)).length;
	return common / Math.max(tokensA.length, tokensB.length);
}

/** Suggest mappings from orphaned variables to unfilled variables by similarity. */
export function suggestMappings(
	orphaned: OrphanedVariable[],
	unfilled: string[],
): Record<string, string> {
	const suggestions: Record<string, string> = {};
	const claimed = new Set<string>();

	// Build scored pairs and sort by similarity descending
	const pairs: { orphan: string; target: string; score: number }[] = [];
	for (const o of orphaned) {
		for (const u of unfilled) {
			const score = similarity(o.name, u);
			if (score >= 0.5) {
				pairs.push({ orphan: o.name, target: u, score });
			}
		}
	}
	pairs.sort((a, b) => b.score - a.score);

	for (const { orphan, target } of pairs) {
		if (suggestions[orphan] || claimed.has(target)) continue;
		suggestions[orphan] = target;
		claimed.add(target);
	}

	return suggestions;
}

// ─── Component ──────────────────────────────────────────────────────────

export default function MigrationDialog({
	report,
	onApply,
	onSkip,
}: {
	report: MigrationReport;
	onApply: (mappings: FieldMapping[], removeOrphaned: string[]) => void;
	onSkip: () => void;
}) {
	const suggestions = useMemo(
		() => suggestMappings(report.orphaned, report.unfilled),
		[report],
	);

	// State: for each orphaned variable, which target is selected (or "" for skip)
	const [selections, setSelections] = useState<Record<string, string>>(() => {
		const initial: Record<string, string> = {};
		for (const o of report.orphaned) {
			initial[o.name] = suggestions[o.name] ?? "";
		}
		return initial;
	});

	// Track which "remove orphaned" checkboxes are checked
	const [removeFlags, setRemoveFlags] = useState<Record<string, boolean>>(
		() => {
			const flags: Record<string, boolean> = {};
			for (const o of report.orphaned) {
				flags[o.name] = true; // default to removing after migration
			}
			return flags;
		},
	);

	// Which unfilled targets are already claimed by a selection
	const claimedTargets = useMemo(() => {
		const claimed = new Set<string>();
		for (const target of Object.values(selections)) {
			if (target) claimed.add(target);
		}
		return claimed;
	}, [selections]);

	const handleSelect = useCallback((orphanName: string, target: string) => {
		setSelections((prev) => ({ ...prev, [orphanName]: target }));
	}, []);

	const handleToggleRemove = useCallback(
		(orphanName: string, checked: boolean) => {
			setRemoveFlags((prev) => ({ ...prev, [orphanName]: checked }));
		},
		[],
	);

	const handleApply = useCallback(() => {
		const mappings: FieldMapping[] = [];
		const removeOrphaned: string[] = [];

		for (const o of report.orphaned) {
			const target = selections[o.name];
			if (target) {
				mappings.push({ from: o.name, to: target });
			} else if (removeFlags[o.name]) {
				removeOrphaned.push(o.name);
			}
		}

		onApply(mappings, removeOrphaned);
	}, [report, selections, removeFlags, onApply]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close
		<dialog
			className="modal modal-open"
			onClick={(e) => {
				if (e.target === e.currentTarget) onSkip();
			}}
		>
			<div className="modal-box max-w-2xl">
				<h3 className="text-lg font-bold mb-1">Questionnaire Updated</h3>
				<p className="text-sm text-base-content/60 mb-4">
					The questionnaire definition has changed since this client's data was
					last synced. The following variables have values but no longer appear
					in the current questionnaire. You can map them to new variable names,
					or remove them.
				</p>

				<div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
					{report.orphaned.map((o) => {
						const selected = selections[o.name] ?? "";
						const isRemove = removeFlags[o.name] ?? true;

						return (
							<div
								key={o.name}
								className="p-3 rounded-lg border border-base-300 bg-base-200/30"
							>
								<div className="flex items-start justify-between gap-3 mb-2">
									<div className="min-w-0">
										<div className="font-medium text-sm truncate">{o.name}</div>
										<div className="text-xs text-base-content/50 truncate mt-0.5">
											Current value:{" "}
											<span className="text-base-content/70">"{o.value}"</span>
										</div>
									</div>
								</div>

								<div className="flex items-center gap-3">
									<span className="text-xs text-base-content/40 shrink-0">
										Map to:
									</span>
									<select
										className="select select-bordered select-sm flex-1"
										value={selected}
										onChange={(e) => handleSelect(o.name, e.target.value)}
									>
										<option value="">(don't map)</option>
										{report.unfilled.map((u) => (
											<option
												key={u}
												value={u}
												disabled={claimedTargets.has(u) && selected !== u}
											>
												{u}
												{claimedTargets.has(u) && selected !== u
													? " (already mapped)"
													: ""}
											</option>
										))}
									</select>
								</div>

								{!selected && (
									<label className="flex items-center gap-2 mt-2 cursor-pointer">
										<input
											type="checkbox"
											className="checkbox checkbox-sm"
											checked={isRemove}
											onChange={(e) =>
												handleToggleRemove(o.name, e.target.checked)
											}
										/>
										<span className="text-xs text-base-content/50">
											Remove this variable from client data
										</span>
									</label>
								)}
							</div>
						);
					})}
				</div>

				<div className="modal-action">
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={onSkip}
					>
						Skip for Now
					</button>
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={handleApply}
					>
						Apply Migration
					</button>
				</div>
			</div>
		</dialog>
	);
}
