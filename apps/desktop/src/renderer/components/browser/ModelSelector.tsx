import type {
	LocalModelSummary,
	ModelProviderSummary,
} from "@kestrel/shared-types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icon";
import {
	configuredProviders,
	modelSupportsThinking,
	modelsForProvider,
	providerDisplayName,
	selectAuto,
	selectModel,
	selectProvider,
	selectThinking,
	selectorTriggerLabel,
	THINKING_LEVELS,
	type ModelSelectorChoice,
} from "./model-selector";

export function ModelSelector({
	providers,
	localModels,
	choice,
	onChange,
}: {
	providers: readonly ModelProviderSummary[];
	localModels: readonly LocalModelSummary[];
	choice: ModelSelectorChoice;
	onChange(next: ModelSelectorChoice): void;
}) {
	const [open, setOpen] = useState(false);
	const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
	const [hoveredProviderId, setHoveredProviderId] = useState(
		choice.providerId || configuredProviders(providers)[0]?.id || "",
	);
	const [hoveredModelId, setHoveredModelId] = useState(choice.model);
	const [customModel, setCustomModel] = useState("");
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const visibleProviders = configuredProviders(providers);
	const activeProviderId =
		hoveredProviderId ||
		choice.providerId ||
		visibleProviders[0]?.id ||
		"";
	const models = modelsForProvider({
		providerId: activeProviderId,
		localModels,
		currentModel: choice.providerId === activeProviderId ? choice.model : "",
	});
	const activeModelId = hoveredModelId || models[0]?.id || "";
	const showThinking = modelSupportsThinking(
		activeProviderId,
		activeModelId,
		localModels,
	);

	useEffect(() => {
		if (!open) return;
		const firstId = configuredProviders(providers)[0]?.id || "";
		setHoveredProviderId(
			choice.executionMode === "automatic"
				? firstId
				: choice.providerId || firstId,
		);
		setHoveredModelId(choice.model);
	}, [choice.executionMode, choice.model, choice.providerId, open, providers]);

	useLayoutEffect(() => {
		if (!open || !triggerRef.current || !menuRef.current) return;
		const button = triggerRef.current.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		let left = button.left;
		let top = button.top - menu.height - 8;
		if (left + menu.width > window.innerWidth - 12)
			left = Math.max(12, window.innerWidth - menu.width - 12);
		if (left < 12) left = 12;
		if (top < 12) top = Math.min(window.innerHeight - menu.height - 12, button.bottom + 8);
		setMenuPos({ top, left });
	}, [open, activeProviderId, activeModelId, showThinking, models.length]);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target))
				return;
			setOpen(false);
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function commit(next: ModelSelectorChoice, close = true) {
		onChange(next);
		if (close) setOpen(false);
	}

	return (
		<div className="model-selector" data-open={open ? "true" : "false"}>
			<button
				ref={triggerRef}
				type="button"
				className="model-selector-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Model: ${selectorTriggerLabel(choice)}`}
				title={`Model: ${selectorTriggerLabel(choice)}`}
				onClick={() => setOpen((current) => !current)}
			>
				<span className="model-selector-trigger-label">
					{selectorTriggerLabel(choice)}
				</span>
				<Icon name="chevron" />
			</button>
			{open &&
				createPortal(
					<div
						ref={menuRef}
						className="model-selector-menu"
						role="menu"
						aria-label="Choose provider, model, and thinking level"
						style={{ top: menuPos.top, left: menuPos.left }}
					>
						<div className="model-selector-column" aria-label="Provider">
							<div className="model-selector-column-header">Provider</div>
							<div className="model-selector-list">
								{visibleProviders.length === 0 ? (
									<p className="model-selector-empty">
										Connect a provider in Settings first.
									</p>
								) : (
									visibleProviders.map((provider) => {
										const selected =
											choice.executionMode === "manual" &&
											choice.providerId === provider.id;
										return (
											<button
												type="button"
												role="menuitem"
												key={provider.id}
												className={`model-selector-item${
													selected ? " is-selected" : ""
												}${
													activeProviderId === provider.id ? " is-active" : ""
												}`}
												onMouseEnter={() => {
													setHoveredProviderId(provider.id);
													setHoveredModelId("");
												}}
												onClick={() =>
													commit(selectProvider(provider.id, localModels, choice), false)
												}
											>
												<span className="model-selector-copy">
													<strong>{providerDisplayName(provider.id)}</strong>
													{provider.capabilities.local ? <small>Local</small> : null}
												</span>
												<Icon name="chevron" />
											</button>
										);
									})
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
									aria-label="Automatically choose a model"
									onClick={() => {
										if (choice.executionMode === "automatic") {
											const providerId =
												activeProviderId || visibleProviders[0]?.id || "";
											if (!providerId) return;
											commit(
												selectProvider(providerId, localModels, choice),
												false,
											);
											return;
										}
										commit(selectAuto(choice));
									}}
								/>
							</div>
						</div>
						<div className="model-selector-column" aria-label="Model">
							<div className="model-selector-column-header">Model</div>
							<div className="model-selector-list">
								{!activeProviderId ? (
									<p className="model-selector-empty">Choose a provider.</p>
								) : models.length === 0 ? (
									<p className="model-selector-empty">
										No catalog models yet. Enter a model ID below.
									</p>
								) : (
									models.map((model) => {
										const selected =
											choice.executionMode === "manual" &&
											choice.providerId === activeProviderId &&
											choice.model === model.id;
										return (
											<button
												type="button"
												role="menuitem"
												key={model.id}
												className={`model-selector-item${
													selected ? " is-selected" : ""
												}${activeModelId === model.id ? " is-active" : ""}`}
												onMouseEnter={() => setHoveredModelId(model.id)}
												onClick={() => {
													const next = selectModel(
														activeProviderId,
														model.id,
														localModels,
														choice,
													);
													commit(next, !model.reasoningLevels);
												}}
											>
												<span className="model-selector-copy">
													<strong>{model.label}</strong>
													{model.detail ? <small>{model.detail}</small> : null}
												</span>
												{model.reasoningLevels ? <Icon name="chevron" /> : null}
											</button>
										);
									})
								)}
							</div>
							{activeProviderId && activeProviderId !== "ollama" ? (
								<form
									className="model-selector-custom"
									onSubmit={(event) => {
										event.preventDefault();
										const model = customModel.trim();
										if (!model) return;
										commit(selectModel(activeProviderId, model, localModels, choice));
										setCustomModel("");
									}}
								>
									<input
										value={customModel}
										onChange={(event) => setCustomModel(event.target.value)}
										placeholder="Custom model ID"
										aria-label="Custom model ID"
									/>
								</form>
							) : null}
						</div>
						{showThinking ? (
							<div className="model-selector-column" aria-label="Thinking level">
								<div className="model-selector-column-header">Thinking level</div>
								<div className="model-selector-list">
									{THINKING_LEVELS.map((level) => {
										const selected =
											choice.executionMode === "manual" &&
											choice.providerId === activeProviderId &&
											choice.model === activeModelId &&
											choice.reasoningEffort === level.id;
										return (
											<button
												type="button"
												role="menuitem"
												key={level.id}
												className={`model-selector-item${
													selected ? " is-selected" : ""
												}`}
												onClick={() =>
													commit(
														selectThinking(
															level.id,
															selectModel(
																activeProviderId,
																activeModelId,
																localModels,
																choice,
															),
														),
													)
												}
											>
												<span className="model-selector-copy">
													<strong>{level.label}</strong>
												</span>
											</button>
										);
									})}
								</div>
							</div>
						) : null}
					</div>,
					document.body,
				)}
		</div>
	);
}
