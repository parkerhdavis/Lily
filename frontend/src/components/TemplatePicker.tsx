import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkflowStore } from "@/stores/workflowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TemplateTreeNode, LilyFile } from "@/types";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLilyIcon } from "@/hooks/useLilyIcon";

// ─── Tree building ──────────────────────────────────────────────────────────

/** Build a navigable folder tree from flat relative paths. */
function buildTree(paths: string[]): TemplateTreeNode[] {
	const root: TemplateTreeNode[] = [];

	for (const relPath of paths) {
		const segments = relPath.split("/");
		let children = root;

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];
			const isFile = i === segments.length - 1;

			if (isFile) {
				children.push({ kind: "file", name, relPath });
			} else {
				let folder = children.find(
					(n): n is TemplateTreeNode & { kind: "folder" } =>
						n.kind === "folder" && n.name === name,
				);
				if (!folder) {
					folder = { kind: "folder", name, children: [] };
					children.push(folder);
				}
				children = folder.children;
			}
		}
	}

	sortTree(root);
	return root;
}

function sortTree(nodes: TemplateTreeNode[]) {
	nodes.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (const n of nodes) {
		if (n.kind === "folder") sortTree(n.children);
	}
}

/** Filter a tree to only include files matching the query (and their parent folders). */
function filterTree(
	nodes: TemplateTreeNode[],
	query: string,
): TemplateTreeNode[] {
	const q = query.trim().toLowerCase();
	if (!q) return nodes;
	const tokens = q.split(/\s+/);

	function matches(name: string): boolean {
		const lower = name.toLowerCase();
		return tokens.every((t) => lower.includes(t));
	}

	function filterNodes(nodes: TemplateTreeNode[]): TemplateTreeNode[] {
		const result: TemplateTreeNode[] = [];
		for (const node of nodes) {
			if (node.kind === "file") {
				if (matches(node.name)) result.push(node);
			} else {
				const filtered = filterNodes(node.children);
				if (filtered.length > 0) {
					result.push({ ...node, children: filtered });
				}
			}
		}
		return result;
	}

	return filterNodes(nodes);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasExistingDocs(
	templateRelPath: string,
	lilyFile: LilyFile | null,
): boolean {
	if (!lilyFile?.documents) return false;
	return Object.values(lilyFile.documents).some(
		(meta) => meta.template_rel_path === templateRelPath,
	);
}

function stripDocx(name: string): string {
	return name.replace(/\.docx$/i, "");
}

// ─── SVG Icons ──────────────────────────────────────────────────────────────

function FolderIcon({ open: isOpen }: { open: boolean }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>{isOpen ? "Open folder" : "Closed folder"}</title>
			{isOpen ? (
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
				/>
			) : (
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
				/>
			)}
		</svg>
	);
}

function DocIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className="h-4 w-4 shrink-0 opacity-50"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
		>
			<title>Document</title>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	);
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function TemplateFolder({
	node,
	lilyFile,
	selectedTemplates,
	onToggleTemplate,
}: {
	node: TemplateTreeNode & { kind: "folder" };
	lilyFile: LilyFile | null;
	selectedTemplates: Set<string>;
	onToggleTemplate: (relPath: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div>
			<button
				type="button"
				className="btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-medium gap-2"
				onClick={() => setExpanded(!expanded)}
			>
				<span className="text-xs opacity-40">
					{expanded ? "\u25BE" : "\u25B8"}
				</span>
				<FolderIcon open={expanded} />
				<span>{node.name}</span>
			</button>
			{expanded && (
				<div className="ml-4 border-l border-base-300 pl-1">
					{node.children.map((child) => (
						<TemplateTreeItem
							key={
								child.kind === "file"
									? child.relPath
									: child.name
							}
							node={child}
							lilyFile={lilyFile}
							selectedTemplates={selectedTemplates}
							onToggleTemplate={onToggleTemplate}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TemplateFile({
	node,
	lilyFile,
	isSelected,
	onToggle,
}: {
	node: TemplateTreeNode & { kind: "file" };
	lilyFile: LilyFile | null;
	isSelected: boolean;
	onToggle: () => void;
}) {
	const hasDocs = hasExistingDocs(node.relPath, lilyFile);

	return (
		<button
			type="button"
			className={`btn btn-ghost btn-sm justify-start text-left w-full h-auto py-2 px-3 font-normal gap-2 ${
				isSelected ? "bg-primary/10 border-primary/30" : ""
			} ${hasDocs ? "text-success" : ""}`}
			onClick={onToggle}
		>
			<input
				type="checkbox"
				className="checkbox checkbox-sm checkbox-primary"
				checked={isSelected}
				readOnly
				tabIndex={-1}
			/>
			<DocIcon />
			<span className="truncate">{stripDocx(node.name)}</span>
			{hasDocs && (
				<span className="badge badge-success badge-xs ml-auto shrink-0">
					in use
				</span>
			)}
		</button>
	);
}

function TemplateTreeItem({
	node,
	lilyFile,
	selectedTemplates,
	onToggleTemplate,
}: {
	node: TemplateTreeNode;
	lilyFile: LilyFile | null;
	selectedTemplates: Set<string>;
	onToggleTemplate: (relPath: string) => void;
}) {
	if (node.kind === "folder") {
		return (
			<TemplateFolder
				node={node}
				lilyFile={lilyFile}
				selectedTemplates={selectedTemplates}
				onToggleTemplate={onToggleTemplate}
			/>
		);
	}
	return (
		<TemplateFile
			node={node}
			lilyFile={lilyFile}
			isSelected={selectedTemplates.has(node.relPath)}
			onToggle={() => onToggleTemplate(node.relPath)}
		/>
	);
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function TemplatePicker() {
	const lilyIcon = useLilyIcon();
	const {
		templates,
		lilyFile,
		loading,
		error,
		addMultipleDocuments,
		loadTemplates,
		returnToHub,
	} = useWorkflowStore();
	const { settings, save } = useSettingsStore();

	const tree = useMemo(() => buildTree(templates), [templates]);
	const [templateSearch, setTemplateSearch] = useState("");
	const filteredTree = useMemo(
		() => filterTree(tree, templateSearch),
		[tree, templateSearch],
	);

	// Multi-select state
	const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(
		new Set(),
	);

	const toggleTemplate = (relPath: string) => {
		setSelectedTemplates((prev) => {
			const next = new Set(prev);
			if (next.has(relPath)) {
				next.delete(relPath);
			} else {
				next.add(relPath);
			}
			return next;
		});
	};

	const handleAddDocuments = async () => {
		if (selectedTemplates.size === 0) return;
		await addMultipleDocuments(
			Array.from(selectedTemplates),
			settings.templates_dir!,
		);
	};

	const pickTemplatesDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Templates Folder",
			defaultPath: settings.templates_dir ?? undefined,
		});
		if (selected) {
			await save({ templates_dir: selected });
			loadTemplates(selected);
		}
	};

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-3">
				<img
					src={lilyIcon}
					alt="Loading..."
					className="size-12 animate-lily-spin"
				/>
			</div>
		);
	}

	if (!settings.templates_dir) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-6 p-8">
				<h2 className="text-2xl font-bold">
					Set Template Library Path
				</h2>
				<p className="text-base-content/70 text-center max-w-md">
					Before selecting a template, you need to choose the
					folder where your template documents are stored.
				</p>
				<button
					type="button"
					className="btn btn-primary"
					onClick={pickTemplatesDir}
				>
					Select Templates Folder
				</button>
				<button
					type="button"
					className="btn btn-ghost btn-sm"
					onClick={returnToHub}
				>
					&larr; Back
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<PageHeader title="Add Documents" onBack={returnToHub} />

			{error && (
				<div className="alert alert-error m-2">
					<span>{error}</span>
				</div>
			)}

			{/* Template library */}
			<div className="flex-1 overflow-y-auto p-5">
				<SectionHeading className="mb-3">
					Template Library
				</SectionHeading>
				{tree.length > 0 && (
					<input
						type="text"
						className="input input-bordered input-sm w-full mb-3"
						placeholder="Search templates..."
						value={templateSearch}
						onChange={(e) => setTemplateSearch(e.target.value)}
					/>
				)}
				{tree.length === 0 ? (
					<p className="text-sm text-base-content/50">
						No .docx templates found in the configured folder.
					</p>
				) : filteredTree.length === 0 ? (
					<p className="text-sm text-base-content/50">
						No templates match your search.
					</p>
				) : (
					<div className="flex flex-col gap-0.5">
						{filteredTree.map((node) => (
							<TemplateTreeItem
								key={
									node.kind === "file"
										? node.relPath
										: node.name
								}
								node={node}
								lilyFile={lilyFile}
								selectedTemplates={selectedTemplates}
								onToggleTemplate={toggleTemplate}
							/>
						))}
					</div>
				)}
			</div>

			{/* Sticky footer: selection bar */}
			{selectedTemplates.size > 0 && (
				<div className="sticky bottom-0 border-t border-base-300 bg-base-100 px-5 py-3 flex items-center justify-between shadow-[0_-4px_16px_rgba(0,0,0,0.15)]">
					<span className="text-sm text-base-content/70">
						{selectedTemplates.size} template
						{selectedTemplates.size !== 1 ? "s" : ""} selected
					</span>
					<div className="flex gap-2">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={() =>
								setSelectedTemplates(new Set())
							}
						>
							Clear
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={handleAddDocuments}
							disabled={loading}
						>
							{loading ? (
								<span className="loading loading-spinner loading-xs" />
							) : (
								`Add ${selectedTemplates.size} Document${selectedTemplates.size !== 1 ? "s" : ""}`
							)}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
