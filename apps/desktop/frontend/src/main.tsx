// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import App from "./App";

const root = document.getElementById("root")!;
root.className = "bg-base-200 min-h-screen";

// A top-level error boundary wraps the whole app (not just the page) so a throw
// during initial render or the splash is caught and the hidden window is
// revealed to surface it. The inner per-page boundary in App still handles
// page-scoped errors with the rest of the chrome intact.
createRoot(root).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
