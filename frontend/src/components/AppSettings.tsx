import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { useWorkflowStore } from "@/stores/workflowStore";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLilyIcon } from "@/hooks/useLilyIcon";

export default function AppSettings() {
	const { settings, save, zoomIn, zoomOut, zoomReset } = useSettingsStore();
	const goToHub = useWorkflowStore((s) => s.goToHub);
	const lilyIcon = useLilyIcon();
	const theme = settings.theme;
	const isDark = theme === "dark";
	const zoom = settings.zoom ?? 100;
	const footerSize = settings.footer_size ?? "medium";

	const setTheme = (value: "light" | "dark") => {
		document.documentElement.setAttribute("data-theme", value);
		save({ theme: value });
	};

	const pickTemplatesDir = async () => {
		const selected = await open({
			directory: true,
			title: "Select Templates Folder",
			defaultPath: settings.templates_dir ?? undefined,
		});
		if (selected) {
			save({ templates_dir: selected });
		}
	};

	return (
		<div className="flex flex-col h-full">
			<PageHeader title="Settings" onBack={goToHub} />

			<div className="flex-1 overflow-y-auto p-8">
				<div className="max-w-lg mx-auto space-y-8">
					{/* Appearance */}
					<section>
						<SectionHeading className="mb-4">
							Appearance
						</SectionHeading>
						<div className="flex items-center justify-between p-4 rounded-xl border border-base-300 bg-base-100">
							<span className="text-sm font-medium">Theme</span>
							<div className="flex rounded-lg overflow-hidden border border-base-300">
								<button
									type="button"
									className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
										!isDark
											? "bg-primary text-primary-content"
											: "bg-base-200 text-base-content/40 hover:bg-base-300"
									}`}
									onClick={() => setTheme("light")}
								>
									Light
								</button>
								<button
									type="button"
									className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
										isDark
											? "bg-primary text-primary-content"
											: "bg-base-200 text-base-content/40 hover:bg-base-300"
									}`}
									onClick={() => setTheme("dark")}
								>
									Dark
								</button>
							</div>
						</div>
					</section>

					{/* Zoom */}
					<section>
						<SectionHeading className="mb-4">
							Zoom
						</SectionHeading>
						<div className="flex items-center justify-between p-4 rounded-xl border border-base-300 bg-base-100">
							<div>
								<p className="text-sm font-medium">
									Interface Scale
								</p>
								<p className="text-xs text-base-content/40 mt-0.5">
									Ctrl+= / Ctrl+- / Ctrl+0
								</p>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="btn btn-outline btn-xs btn-square"
									onClick={zoomOut}
									disabled={zoom <= 50}
								>
									-
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs min-w-12"
									onClick={zoomReset}
								>
									{zoom}%
								</button>
								<button
									type="button"
									className="btn btn-outline btn-xs btn-square"
									onClick={zoomIn}
									disabled={zoom >= 200}
								>
									+
								</button>
							</div>
						</div>
					</section>

					{/* Footer size */}
					<section>
						<div className="flex items-center justify-between p-4 rounded-xl border border-base-300 bg-base-100">
							<p className="text-sm font-medium">
								Status Bar Size
							</p>
							<div className="flex rounded-lg overflow-hidden border border-base-300">
								{(
									[
										{ value: "small", label: "Small" },
										{
											value: "medium",
											label: "Medium",
										},
										{ value: "large", label: "Large" },
									] as const
								).map((opt) => (
									<button
										key={opt.value}
										type="button"
										className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
											footerSize === opt.value
												? "bg-primary text-primary-content"
												: "bg-base-200 text-base-content/40 hover:bg-base-300"
										}`}
										onClick={() =>
											save({
												footer_size: opt.value,
											})
										}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>
					</section>

					{/* Workspace */}
					<section>
						<SectionHeading className="mb-4">
							Workspace
						</SectionHeading>
						<div className="p-4 rounded-xl border border-base-300 bg-base-100 space-y-3">
							<div>
								<p className="text-sm font-medium mb-1">
									Templates Folder
								</p>
								<p className="text-xs text-base-content/40 font-mono break-all">
									{settings.templates_dir ?? "Not configured"}
								</p>
							</div>
							<button
								type="button"
								className="btn btn-outline btn-sm"
								onClick={pickTemplatesDir}
							>
								{settings.templates_dir ? "Change" : "Set"}{" "}
								Templates Folder
							</button>
						</div>
					</section>

					{/* About */}
					<section>
						<SectionHeading className="mb-4">About</SectionHeading>
						<div className="p-4 rounded-xl border border-base-300 bg-base-100">
							<div className="flex items-center gap-3">
								<img
									src={lilyIcon}
									alt=""
									className="size-8 opacity-60"
								/>
								<div>
									<p className="text-sm font-semibold">
										Lily
									</p>
									<p className="text-xs text-base-content/40">
										Document preparation for Carelaw
										Colorado
									</p>
								</div>
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
