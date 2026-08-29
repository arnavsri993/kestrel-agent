import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
	UserBrowserOriginFavicon,
	UserBrowserTab,
	UserBrowserTabFolderColor,
	UserBrowserTabOrganizationPreview,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import { tabFaviconDataUrl } from "./tab-favicon";

const FOLDER_COLORS: readonly UserBrowserTabFolderColor[] = [
	"blue",
	"green",
	"amber",
	"rose",
	"violet",
	"teal",
	"slate",
];

const FOLDER_COLOR_LABELS: Record<UserBrowserTabFolderColor, string> = {
	blue: "Blue",
	green: "Green",
	amber: "Amber",
	rose: "Rose",
	violet: "Violet",
	teal: "Teal",
	slate: "Slate",
};

function hostForTab(tab: UserBrowserTab): string {
	try {
		return new URL(tab.url).hostname.replace(/^www\./, "");
	} catch {
		return "Kestrel";
	}
}

function faviconForTab(
	tab: UserBrowserTab,
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[] | undefined,
) {
	if (tab.file) return <Icon name="artifacts" />;
	const faviconDataUrl = tabFaviconDataUrl(tab, originFavicons);
	if (faviconDataUrl) return <img src={faviconDataUrl} alt="" />;
	if (!tab.url) return <Icon name="globe" />;
	return <span>{hostForTab(tab).charAt(0).toUpperCase()}</span>;
}

export function OrganizeTabsDialog({
	preview,
	originFavicons,
	onCancel,
	onApply,
}: {
	preview: UserBrowserTabOrganizationPreview;
	originFavicons?: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onCancel(): void;
	onApply(organization: UserBrowserTabOrganizationPreview): Promise<void>;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [organization, setOrganization] =
		useState<UserBrowserTabOrganizationPreview>(preview);
	const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [editingColor, setEditingColor] =
		useState<UserBrowserTabFolderColor>("blue");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const editInputRef = useRef<HTMLInputElement | null>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		setOrganization(preview);
		setCollapsedFolderIds(new Set());
		setEditingFolderId(null);
		setError("");
	}, [preview]);

	useEffect(() => {
		if (!returnFocusRef.current && document.activeElement instanceof HTMLElement)
			returnFocusRef.current = document.activeElement;
		const frame = window.requestAnimationFrame(() => {
			(
				dialogRef.current?.querySelector<HTMLElement>(
					"[data-organize-tabs-initial-focus]",
				)
			)?.focus();
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusable = Array.from(
				dialogRef.current.querySelectorAll<HTMLElement>(
					"button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
				),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
			returnFocusRef.current?.focus();
		};
	}, [onCancel]);

	useEffect(() => {
		if (!editingFolderId) return;
		const frame = window.requestAnimationFrame(() => {
			editInputRef.current?.focus();
			editInputRef.current?.select();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [editingFolderId]);

	const tabsByFolderId = useMemo(() => {
		const result = new Map<string, UserBrowserTab[]>();
		for (const tab of organization.tabs) {
			if (!tab.tabFolderId) continue;
			const current = result.get(tab.tabFolderId) ?? [];
			current.push(tab);
			result.set(tab.tabFolderId, current);
		}
		return result;
	}, [organization.tabs]);

	const visibleFolders = useMemo(
		() =>
			organization.tabFolders.filter(
				(folder) => (tabsByFolderId.get(folder.id)?.length ?? 0) >= 2,
			),
		[organization.tabFolders, tabsByFolderId],
	);

	function beginEdit(folderId: string) {
		const folder = organization.tabFolders.find((item) => item.id === folderId);
		if (!folder) return;
		setEditingFolderId(folder.id);
		setEditingName(folder.name);
		setEditingColor(folder.color);
	}

	function cancelEdit() {
		setEditingFolderId(null);
		setEditingName("");
	}

	function saveEdit(event?: FormEvent) {
		event?.preventDefault();
		if (!editingFolderId) return;
		const folder = organization.tabFolders.find(
			(item) => item.id === editingFolderId,
		);
		if (!folder) return cancelEdit();
		const name = editingName.trim();
		if (!name) {
			setError("Give this folder a name before saving.");
			return;
		}
		setOrganization((current) => ({
			...current,
			tabFolders: current.tabFolders.map((item) =>
				item.id === editingFolderId
					? { ...item, name: name.slice(0, 80), color: editingColor }
					: item,
			),
		}));
		setError("");
		cancelEdit();
	}

	function toggleFolder(folderId: string) {
		setCollapsedFolderIds((current) => {
			const next = new Set(current);
			if (next.has(folderId)) next.delete(folderId);
			else next.add(folderId);
			return next;
		});
	}

	async function apply() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const validFolderIds = new Set(visibleFolders.map((folder) => folder.id));
			await onApply({
				...organization,
				tabFolders: visibleFolders,
				tabs: organization.tabs.map((tab) =>
					tab.tabFolderId && !validFolderIds.has(tab.tabFolderId)
						? { ...tab, tabFolderId: undefined }
						: tab,
				),
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The tabs could not be organized. Try again.",
			);
			setBusy(false);
		}
	}

	return (
		<div
			className="organize-tabs-overlay"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<motion.div
				ref={dialogRef}
				className="organize-tabs-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="organize-tabs-title"
				initial={reducedMotion ? false : { opacity: 0, scale: 0.98, y: 8 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				transition={{ duration: reducedMotion ? 0 : 0.16 }}
				aria-busy={busy}
			>
				<header className="organize-tabs-dialog-header">
					<h2 id="organize-tabs-title">Organize tabs</h2>
					<button
						type="button"
						className="organize-tabs-close"
						aria-label="Close organize tabs"
						data-organize-tabs-initial-focus
						onClick={onCancel}
						disabled={busy}
					>
						<Icon name="close" />
					</button>
				</header>

				<div className="organize-tabs-scroll" role="list" aria-label="Suggested tab folders">
					{visibleFolders.length === 0 ? (
						<div className="organize-tabs-empty" role="status">
							<Icon name="folder" />
							<strong>No groups to suggest</strong>
							<span>Open a few related pages, then try again.</span>
						</div>
					) : (
						visibleFolders.map((folder) => {
							const folderTabs = tabsByFolderId.get(folder.id) ?? [];
							const collapsed = collapsedFolderIds.has(folder.id);
							const editing = editingFolderId === folder.id;
							const groupId = `organize-tabs-group-${folder.id}`;
							return (
								<section
									key={folder.id}
									className={`organize-tabs-group organize-tabs-group-${folder.color}`}
									role="listitem"
									aria-label={`${folder.name} folder`}
								>
									<div className="organize-tabs-group-header">
										<button
											type="button"
											className="organize-tabs-group-toggle"
											aria-expanded={!collapsed}
											aria-controls={groupId}
											onClick={() => toggleFolder(folder.id)}
										>
											<span className="organize-tabs-folder-chip">
												<Icon
													name="chevron"
													className={collapsed ? "" : "expanded"}
												/>
												<span>{folder.name}</span>
												<small>{folderTabs.length}</small>
											</span>
										</button>
										<button
											type="button"
											className="organize-tabs-edit"
											aria-label={`Edit ${folder.name} folder`}
											onClick={() => beginEdit(folder.id)}
										>
											<Icon name="writing" />
										</button>
									</div>
									{editing && (
										<form
											className="organize-tabs-edit-form"
											onSubmit={saveEdit}
										>
											<label>
												<span>Folder name</span>
												<input
													ref={editInputRef}
													value={editingName}
													maxLength={80}
													onChange={(event) => setEditingName(event.target.value)}
													onKeyDown={(event) => {
														if (event.key === "Escape") {
															event.preventDefault();
															event.stopPropagation();
															cancelEdit();
														}
													}}
												/>
											</label>
											<div className="organize-tabs-color-picker" role="group" aria-label="Folder color">
												{FOLDER_COLORS.map((color) => (
													<button
														key={color}
														type="button"
														className={`organize-tabs-color-swatch organize-tabs-color-swatch-${color}`}
														aria-label={FOLDER_COLOR_LABELS[color]}
														aria-pressed={editingColor === color}
														onClick={() => setEditingColor(color)}
													/>
												))}
											</div>
											<div className="organize-tabs-edit-actions">
												<button type="button" onClick={cancelEdit}>
													Cancel
												</button>
												<button type="submit">Save</button>
											</div>
										</form>
									)}
									<motion.div
										id={groupId}
										className="organize-tabs-group-tabs"
										initial={false}
										animate={{
											opacity: collapsed ? 0 : 1,
											height: collapsed ? 0 : "auto",
										}}
										transition={{ duration: reducedMotion ? 0 : 0.14 }}
										aria-hidden={collapsed}
									>
										{folderTabs.map((tab) => (
											<div className="organize-tabs-tab" key={tab.id}>
												<span className="organize-tabs-tab-favicon" aria-hidden="true">
													{faviconForTab(tab, originFavicons)}
												</span>
												<span className="organize-tabs-tab-copy">
													<strong>{tab.title}</strong>
													<small>{hostForTab(tab)}</small>
												</span>
											</div>
										))}
									</motion.div>
								</section>
							);
						})
					)}
				</div>

				{error && <p className="organize-tabs-error" role="alert">{error}</p>}
				<footer className="organize-tabs-dialog-footer">
					<button
						type="button"
						className="organize-tabs-secondary"
						onClick={onCancel}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="button"
						className="organize-tabs-primary"
						onClick={() => void apply()}
						disabled={busy || visibleFolders.length === 0}
					>
						{busy ? "Organizing…" : "Group tabs"}
					</button>
				</footer>
			</motion.div>
		</div>
	);
}
