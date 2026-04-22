import type React from "react";

interface UnsavedChangesDialogProps {
	dialogRef: React.RefObject<HTMLDialogElement | null>;
	onDiscard: () => void;
	onCancel: () => void;
	onSave: () => void;
}

export default function UnsavedChangesDialog({
	dialogRef,
	onDiscard,
	onCancel,
	onSave,
}: UnsavedChangesDialogProps) {
	return (
		/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog backdrop close */
		<dialog
			ref={dialogRef}
			className="modal"
			onClick={(e) => {
				if (e.target === dialogRef.current)
					dialogRef.current?.close();
			}}
		>
			<div className="modal-box">
				<h3 className="font-bold text-lg">
					Unsaved Changes
				</h3>
				<p className="py-4 text-base-content/70">
					You have unsaved changes to this document.
					Would you like to save before leaving?
				</p>
				<div className="modal-action">
					<button
						type="button"
						className="btn btn-ghost"
						onClick={onDiscard}
					>
						Discard
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-primary"
						onClick={onSave}
					>
						Save & Leave
					</button>
				</div>
			</div>
		</dialog>
	);
}
