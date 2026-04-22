/**
 * Small colored dot indicating filled/unfilled status.
 * Used alongside variable labels and field names.
 */
export default function StatusDot({
	filled,
	className,
}: {
	filled: boolean;
	className?: string;
}) {
	return (
		<span
			className={`inline-block size-2 shrink-0 rounded-full ${filled ? "bg-success" : "bg-base-300"} ${className ?? ""}`}
		/>
	);
}
