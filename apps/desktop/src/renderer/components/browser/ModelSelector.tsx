import type { ProviderAccountSummary } from "@kestrel/shared-types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KESTREL_MENU_TRANSITION } from "../../motion-contract";
import { Icon } from "../Icon";
import {
	accountForChoice,
	matchesCatalogSearch,
	modelAvailabilityLabel,
	modelForChoice,
	providerGroups,
	selectableModel,
	selectAuto,
	selectCustomModel,
	selectModel,
	selectThinking,
	selectorTriggerLabel,
	THINKING_LEVELS,
	type ModelSelectorChoice,
} from "./model-selector";

function providerLabel(value: string): string {
	return value
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

function discoveryLabel(account: ProviderAccountSummary): string {
	switch (account.discovery.state) {
		case "fresh":
			return "Catalog refreshed";
		case "stale":
			return "Cached catalog is stale";
		case "failed":
			return "Catalog refresh failed";
		case "unsupported":
			return "No supported model listing";
		default:
			return "Catalog not refreshed";
	}
}

export function ModelSelector({
	accounts,
	choice,
	onChange,
}: {
	accounts: readonly ProviderAccountSummary[];
	choice: ModelSelectorChoice;
	onChange(next: ModelSelectorChoice): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [menuPos, setMenuPos] = useState({
		top: 0,
		left: 0,
		placement: "above" as "above" | "below",
	});
	const groups = useMemo(() => providerGroups(accounts), [accounts]);
	const visibleGroups = useMemo(
		() => groups.filter((group) => matchesCatalogSearch(group, query)),
		[groups, query],
	);
	const selectedAccount = accountForChoice(accounts, choice);
	const [activeProviderId, setActiveProviderId] = useState(
		selectedAccount?.providerId ?? groups[0]?.id ?? "",
	);
	const [activeAccountId, setActiveAccountId] = useState(
		selectedAccount?.id ?? groups[0]?.accounts[0]?.id ?? "",
	);
	const [activeModelId, setActiveModelId] = useState(choice.model);
	const [customModel, setCustomModel] = useState("");
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const didFocusMenuRef = useRef(false);
	const activeGroup =
		visibleGroups.find((group) => group.id === activeProviderId) ??
		visibleGroups[0];
	const activeAccount =
		activeGroup?.accounts.find((account) => account.id === activeAccountId) ??
		activeGroup?.accounts[0];
	const visibleModels = useMemo(() => {
		if (!activeAccount) return [];
		const normalized = query.trim().toLocaleLowerCase();
		return activeAccount.models.filter(
			(model) =>
				!normalized ||
				model.id.toLocaleLowerCase().includes(normalized) ||
				model.displayName.toLocaleLowerCase().includes(normalized),
		);
	}, [activeAccount, query]);
	const activeModel =
		visibleModels.find((model) => model.id === activeModelId) ??
		modelForChoice(accounts, choice) ??
		visibleModels[0];
	const showThinking =
		activeModel?.capabilities.capabilityProvenance === "confirmed" &&
		activeModel.capabilities.reasoningEfforts.length > 1;

	useEffect(() => {
		if (!open) return;
		const account = accountForChoice(accounts, choice) ?? groups[0]?.accounts[0];
		setActiveProviderId(account?.providerId ?? "");
		setActiveAccountId(account?.id ?? "");
		setActiveModelId(choice.model);
		setQuery("");
	}, [accounts, choice, groups, open]);

	const positionMenu = useCallback(() => {
		if (!triggerRef.current || !menuRef.current) return;
		const button = triggerRef.current.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		let left = button.left;
		let top = button.top - menu.height - 8;
		let placement: "above" | "below" = "above";
		if (left + menu.width > window.innerWidth - 12)
			left = Math.max(12, window.innerWidth - menu.width - 12);
		if (left < 12) left = 12;
		if (top < 12) {
			top = Math.min(window.innerHeight - menu.height - 12, button.bottom + 8);
			placement = "below";
		}
		setMenuPos({ top, left, placement });
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		positionMenu();
		if (!didFocusMenuRef.current) {
			didFocusMenuRef.current = true;
			window.requestAnimationFrame(() =>
				menuRef.current?.querySelector<HTMLInputElement>("input")?.focus(),
			);
		}
	}, [activeAccountId, activeModelId, open, positionMenu, showThinking, visibleModels.length]);

	useEffect(() => {
		if (!open) return;
		const reposition = () => positionMenu();
		window.addEventListener("resize", reposition);
		window.addEventListener("scroll", reposition, true);
		return () => {
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [open, positionMenu]);

	function closeMenu({ restoreFocus = false }: { restoreFocus?: boolean } = {}) {
		setOpen(false);
		didFocusMenuRef.current = false;
		if (restoreFocus)
			window.requestAnimationFrame(() => triggerRef.current?.focus());
	}

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
				return;
			closeMenu();
		}
		function onFocusIn(event: FocusEvent) {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
				return;
			closeMenu();
		}
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			closeMenu({ restoreFocus: true });
		}
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("focusin", onFocusIn);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("focusin", onFocusIn);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function commit(next: ModelSelectorChoice, close = true) {
		onChange(next);
		if (close) closeMenu({ restoreFocus: true });
	}

	function selectFirstModel(account: ProviderAccountSummary): ModelSelectorChoice | undefined {
		const model = account.models.find(selectableModel);
		return model ? selectModel(account, model, choice) : undefined;
	}

	return (
		<div className="model-selector" data-open={open ? "true" : "false"}>
			<button
				ref={triggerRef}
				type="button"
				className="model-selector-trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`Model: ${selectorTriggerLabel(choice, accounts)}`}
				title={`Model: ${selectorTriggerLabel(choice, accounts)}`}
				onClick={() =>
					setOpen((current) => {
						if (current)
							window.requestAnimationFrame(() => triggerRef.current?.focus());
						return !current;
					})
				}
			>
				<span className="model-selector-trigger-label">
					{selectorTriggerLabel(choice, accounts)}
				</span>
				<Icon name="chevron" />
			</button>
			{createPortal(
				<AnimatePresence initial={false}>
					{open ? (
						<motion.div
							ref={menuRef}
							className="model-selector-menu model-selector-menu-accounts"
							role="dialog"
							aria-label="Choose a provider, account, model, and thinking level"
							data-placement={menuPos.placement}
							initial={
								reducedMotion
									? false
									: {
											opacity: 0,
											y: menuPos.placement === "above" ? 4 : -4,
													scale: 0.992,
										}
							}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={
								reducedMotion
									? { opacity: 1, y: 0, scale: 1, pointerEvents: "none" }
									: {
											opacity: 0,
											y: menuPos.placement === "above" ? 4 : -4,
											scale: 0.992,
											pointerEvents: "none",
										}
							}
							transition={reducedMotion ? { duration: 0 } : KESTREL_MENU_TRANSITION}
							style={{ top: menuPos.top, left: menuPos.left }}
						>
							<div className="model-selector-search">
								<input
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="Search accounts and models"
									aria-label="Search provider accounts and models"
								/>
								<span className="sr-only" aria-live="polite">
									{visibleGroups.length} provider groups available.
								</span>
							</div>
							<div className="model-selector-columns">
								<div className="model-selector-column" aria-label="Provider">
									<div className="model-selector-column-header">Provider</div>
									<div className="model-selector-list">
										{visibleGroups.length === 0 ? (
											<p className="model-selector-empty">
												Connect an account in Settings first.
											</p>
										) : (
											visibleGroups.map((group) => (
												<button
													type="button"
													key={group.id}
													className={`model-selector-item${
														activeGroup?.id === group.id ? " is-active" : ""
													}`}
													onMouseEnter={() => {
														setActiveProviderId(group.id);
														setActiveAccountId(group.accounts[0]?.id ?? "");
														setActiveModelId("");
													}}
													onClick={() => {
														setActiveProviderId(group.id);
														setActiveAccountId(group.accounts[0]?.id ?? "");
														setActiveModelId("");
													}}
												>
													<span className="model-selector-copy">
														<strong>{providerLabel(group.label)}</strong>
														<small>{group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}</small>
													</span>
													<Icon name="chevron" />
												</button>
											))
										)}
									</div>
									<div className="model-selector-footer">
										<span>Auto</span>
										<button
											type="button"
											className={`model-selector-toggle${
												choice.executionMode === "automatic" ? " is-on" : ""
											}`}
											role="switch"
											aria-checked={choice.executionMode === "automatic"}
											aria-label="Automatically choose a discovered available model"
											onClick={() => {
												if (choice.executionMode !== "automatic") {
													commit(selectAuto(choice));
													return;
												}
												if (!activeAccount) return;
												const next = selectFirstModel(activeAccount);
												if (next) commit(next, false);
											}}
										/>
									</div>
								</div>
								<div className="model-selector-column" aria-label="Account">
									<div className="model-selector-column-header">Account</div>
									<div className="model-selector-list">
										{!activeGroup ? (
											<p className="model-selector-empty">Choose a provider.</p>
										) : (
											activeGroup.accounts.map((account) => (
												<button
													type="button"
													key={account.id}
													className={`model-selector-item${
														activeAccount?.id === account.id ? " is-active" : ""
													}${
														choice.executionMode === "manual" && choice.accountId === account.id
															? " is-selected"
															: ""
													}`}
													onMouseEnter={() => {
														setActiveAccountId(account.id);
														setActiveModelId("");
													}}
													onClick={() => {
														setActiveAccountId(account.id);
														setActiveModelId("");
													}}
												>
													<span className="model-selector-copy">
														<strong>{account.displayName}</strong>
														<small>{discoveryLabel(account)}</small>
													</span>
													<Icon name="chevron" />
												</button>
											))
										)}
									</div>
								</div>
								<div className="model-selector-column" aria-label="Model">
									<div className="model-selector-column-header">Model</div>
									<div className="model-selector-list">
										{!activeAccount ? (
											<p className="model-selector-empty">Choose an account.</p>
										) : visibleModels.length === 0 ? (
											<p className="model-selector-empty">
												No discovered models match. You can enter an explicit model ID below.
											</p>
										) : (
											visibleModels.map((model) => {
												const selected =
													choice.executionMode === "manual" &&
													choice.accountId === activeAccount.id &&
													choice.model === model.id;
												const selectable = selectableModel(model);
												const supportsThinking =
													model.capabilities.capabilityProvenance === "confirmed" &&
													model.capabilities.reasoningEfforts.length > 1;
												return (
													<button
														type="button"
														key={model.id}
														disabled={!selectable}
														className={`model-selector-item${
															selected ? " is-selected" : ""
														}${activeModel?.id === model.id ? " is-active" : ""}`}
														onMouseEnter={() => setActiveModelId(model.id)}
														onClick={() => {
															setActiveModelId(model.id);
															const next = selectModel(activeAccount, model, choice);
														commit(next, !supportsThinking);
														}}
													>
														<span className="model-selector-copy">
															<strong>{model.displayName}</strong>
															<small>{modelAvailabilityLabel(model)} · {model.discoverySource.replaceAll("_", " ")}</small>
														</span>
														{supportsThinking ? <Icon name="chevron" /> : null}
													</button>
												);
											})
										)}
									</div>
									{activeAccount ? (
										<form
											className="model-selector-custom"
											onSubmit={(event) => {
												event.preventDefault();
												const model = customModel.trim();
												if (!model) return;
												commit(selectCustomModel(activeAccount, model, choice));
												setCustomModel("");
											}}
										>
											<input
												value={customModel}
												onChange={(event) => setCustomModel(event.target.value)}
												placeholder="Explicit model ID"
												aria-label="Explicit model ID"
											/>
										</form>
									) : null}
								</div>
								{showThinking && activeAccount && activeModel ? (
									<div className="model-selector-column" aria-label="Thinking level">
										<div className="model-selector-column-header">Thinking</div>
										<div className="model-selector-list">
											{THINKING_LEVELS.filter((level) =>
												activeModel.capabilities.reasoningEfforts.includes(level.id),
											).map((level) => (
												<button
													type="button"
													key={level.id}
													className={`model-selector-item${
														choice.executionMode === "manual" &&
														choice.accountId === activeAccount.id &&
														choice.model === activeModel.id &&
														choice.reasoningEffort === level.id
															? " is-selected"
															: ""
													}`}
													onClick={() =>
														commit(
															selectThinking(
																level.id,
																selectModel(activeAccount, activeModel, choice),
															),
														)
													}
												>
													<span className="model-selector-copy"><strong>{level.label}</strong></span>
												</button>
											))}
										</div>
									</div>
								) : null}
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>,
				document.body,
			)}
		</div>
	);
}
