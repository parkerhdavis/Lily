import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

const root = document.getElementById("root")!;
root.className = "bg-base-200 min-h-screen";

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
