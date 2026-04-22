import type { ReactNode } from "react";

/**
 * Uppercase section label for grouping content areas.
 * Used in sidebars, panel headers, and content sections.
 */
export default function SectionHeading({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h3
			className={`text-xs font-semibold uppercase tracking-wider text-base-content/50 ${className ?? ""}`}
		>
			{children}
		</h3>
	);
}
