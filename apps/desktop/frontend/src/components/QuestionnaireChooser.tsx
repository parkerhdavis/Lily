// SPDX-License-Identifier: AGPL-3.0-or-later
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type {
	QuestionnaireIndex,
	QuestionnaireIndexEntry,
} from "@/types/questionnaire";

export interface QuestionnaireChoice {
	id: string;
	version: number;
}

/**
 * Single-select list of the questionnaires in the library. Loads the index on
 * mount, pre-selects the first entry, and reports the current selection via
 * `onChange`. This is the point-of-use replacement for the old global "active
 * questionnaire": shown at client creation and the first time an un-stamped
 * client's questionnaire is opened.
 */
export default function QuestionnaireChooser({
	onChange,
}: {
	/** Fires with the current choice (or null when the library is empty).
	 *  Pass a stable reference — a `useState` setter or a `useCallback`. */
	onChange: (choice: QuestionnaireChoice | null) => void;
}) {
	const [entries, setEntries] = useState<QuestionnaireIndexEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		invoke<QuestionnaireIndex>("load_questionnaire_index")
			.then((index) => {
				if (!alive) return;
				setEntries(index.questionnaires);
				setSelectedId(
					index.questionnaires.length > 0 ? index.questionnaires[0].id : null,
				);
			})
			.catch(() => {
				if (alive) setEntries([]);
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, []);

	// Report the current selection upward whenever it resolves.
	useEffect(() => {
		const entry = entries.find((e) => e.id === selectedId);
		onChange(entry ? { id: entry.id, version: entry.version } : null);
	}, [selectedId, entries, onChange]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 text-sm text-base-content/50">
				<span className="loading loading-spinner loading-xs" />
				Loading questionnaires…
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div className="text-sm text-base-content/50 italic">
				No questionnaires available. Add one in Pipeline → Client Setup first.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 w-full">
			{entries.map((q) => (
				<label
					key={q.id}
					className="label cursor-pointer justify-start gap-2 py-1"
				>
					<input
						type="radio"
						name="questionnaire-choice"
						className="radio radio-sm radio-primary"
						checked={selectedId === q.id}
						onChange={() => setSelectedId(q.id)}
					/>
					<span className="label-text text-sm">
						{q.name}
						<span className="text-base-content/40"> (v{q.version})</span>
					</span>
				</label>
			))}
		</div>
	);
}
