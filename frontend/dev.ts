/**
 * Development Server
 *
 * Replaces Vite's dev server with Bun.serve() + Tailwind CLI + file watcher.
 * Serves built output on port 5173 (where Tauri expects it) and triggers
 * full-page reloads via WebSocket on source changes.
 *
 * HMR is intentionally not implemented — this is a desktop app where state
 * lives in Zustand stores and survives page reloads. Full reloads are fast
 * and avoid the complexity of a React Fast Refresh integration.
 */

import { watch } from "fs";
import { cp, mkdir } from "fs/promises";
import { existsSync } from "fs";
import type { ServerWebSocket } from "bun";

const DEV_PORT = 5173;
const DIST = "dist";

const reloadClients = new Set<ServerWebSocket<unknown>>();

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

async function buildCSS() {
	const proc = Bun.spawn(
		["bunx", "@tailwindcss/cli", "-i", "src/styles/index.css", "-o", `${DIST}/styles.css`],
		{ stdout: "inherit", stderr: "inherit" },
	);
	await proc.exited;
}

async function buildMain() {
	await Bun.build({
		entrypoints: ["src/main.tsx"],
		outdir: DIST,
		target: "browser",
		naming: "[name].js",
		define: { "process.env.NODE_ENV": '"development"' },
	});
}

async function copyAssets() {
	if (existsSync("public")) {
		await cp("public", DIST, { recursive: true });
	}

	// Inject live-reload WebSocket client into index.html
	let html = await Bun.file("index.html").text();
	const reloadScript = `<script>new WebSocket("ws://localhost:${DEV_PORT}/__reload").onmessage=()=>location.reload()</script>`;
	html = html.replace("</body>", `${reloadScript}\n</body>`);
	await Bun.write(`${DIST}/index.html`, html);
}

async function buildAll() {
	await mkdir(DIST, { recursive: true });
	await Promise.all([buildCSS(), buildMain(), copyAssets()]);
}

// ---------------------------------------------------------------------------
// Initial build
// ---------------------------------------------------------------------------
console.log("Building...");
await buildAll();

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------
Bun.serve({
	port: DEV_PORT,
	fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for live reload
		if (url.pathname === "/__reload") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Serve from dist/
		const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(`${DIST}${filePath}`);
		return new Response(file);
	},
	websocket: {
		open(ws) { reloadClients.add(ws); },
		close(ws) { reloadClients.delete(ws); },
		message() {},
	},
});

console.log(`Dev server running at http://localhost:${DEV_PORT}`);

// ---------------------------------------------------------------------------
// File watcher — rebuild and reload on source changes
// ---------------------------------------------------------------------------
let rebuildTimer: Timer | null = null;

function scheduleRebuild() {
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		const start = performance.now();
		try {
			await buildAll();
			const ms = (performance.now() - start).toFixed(0);
			console.log(`Rebuilt in ${ms}ms — reloading`);
			for (const client of reloadClients) {
				client.send("reload");
			}
		} catch (e) {
			console.error("Rebuild failed:", e);
		}
	}, 100); // debounce 100ms
}

watch("src", { recursive: true }, scheduleRebuild);
watch("index.html", scheduleRebuild);
