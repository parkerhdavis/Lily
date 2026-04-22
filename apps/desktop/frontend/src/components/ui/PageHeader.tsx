import type { ReactNode } from "react";
import AppSwitcher from "@/components/ui/AppSwitcher";

interface PageHeaderProps {
	title: ReactNode;
	subtitle?: string;
	onBack?: () => void;
	backLabel?: string;
	children?: ReactNode;
	/** Show the app switcher in the header. Defaults to true. */
	showAppSwitcher?: boolean;
}

/**
 * Consistent header bar used across all workflow screens.
 * Provides back navigation, title/subtitle, a slot for right-side actions,
 * and the app switcher for branch navigation.
 */
export default function PageHeader({
	title,
	subtitle,
	onBack,
	backLabel = "Back",
	children,
	showAppSwitcher = true,
}: PageHeaderProps) {
	return (
		<header className="flex items-center gap-4 px-5 py-3 border-b border-base-300 bg-base-100">
			{onBack && (
				<button
					type="button"
					className="btn btn-ghost btn-sm gap-1.5 text-base-content/70 hover:text-base-content"
					onClick={onBack}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						className="size-4"
					>
						<title>Back</title>
						<path
							fillRule="evenodd"
							d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
							clipRule="evenodd"
						/>
					</svg>
					{backLabel}
				</button>
			)}
			<div className="flex-1 min-w-0">
				<h2 className="text-lg font-semibold truncate">{title}</h2>
				{subtitle && (
					<p className="text-xs text-base-content/40 truncate">
						{subtitle}
					</p>
				)}
			</div>
			{children && (
				<div className="flex items-center gap-2 shrink-0">
					{children}
				</div>
			)}
			{showAppSwitcher && <AppSwitcher />}
		</header>
	);
}
