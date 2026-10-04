import {
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import type { RuntimeSession } from "@kestrel/shared-types";
import { agentWorkspaceName } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	clampAgentPanelWidth,
	agentPanelUsesOverlay,
	AGENT_PANEL_MIN_WIDTH,
	handoffSpringVelocity,
	projectedPanelWidth,
	springStep,
} from "../../motion-contract";
import { Icon } from "../Icon";

const AGENT_PANEL_WIDTH_KEY = "kestrel:agent-panel-width";

function defaultAgentPanelWidth(viewportWidth: number): number {
	if (viewportWidth <= 980) return 480;
	if (viewportWidth <= 1_120) return 520;
	return 560;
}

export function AgentSidebar({
	children,
	communicationAssistant,
	sessions,
	activeSessionId,
	agentName,
	collapsed,
	onNewAgent,
	onToggleAgent,
	onExpandChat,
}: {
	children: ReactNode;
	communicationAssistant?: ReactNode;
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	agentName: string;
	collapsed: boolean;
	onNewAgent(prompt?: string): void;
	onToggleAgent(): void;
	onExpandChat(): void;
}) {
	const sidebarRef = useRef<HTMLElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
	const compact = agentPanelUsesOverlay(viewportWidth);
	const resizeRef = useRef<{
		pointerId: number;
		startX: number;
		startWidth: number;
		width: number;
		lastX: number;
		lastAt: number;
		velocity: number;
	} | null>(null);
	const settleFrameRef = useRef<number | null>(null);
	const settleMotionRef = useRef<{ position: number; velocity: number } | null>(
		null,
	);
	const visibilityMountedRef = useRef(false);
	const previousCollapsedRef = useRef(collapsed);
	const resizeHandleRef = useRef<HTMLDivElement | null>(null);
	const [panelWidth, setPanelWidth] = useState(() =>
		defaultAgentPanelWidth(window.innerWidth),
	);

	function shell() {
		return document.querySelector<HTMLElement>(".ai-browser-app");
	}

	function writePanelWidth(width: number) {
		const root = shell();
		if (!root) return;
		root.style.setProperty("--agent-panel-user-width", `${width.toFixed(2)}px`);
		resizeHandleRef.current?.setAttribute("aria-valuenow", String(Math.round(clampAgentPanelWidth(width, window.innerWidth))));
	}

	function writePresentedPanelWidth(width: number) {
		const root = shell();
		if (!root) return;
		const safeWidth = Math.max(0, width);
		root.style.setProperty(
			"--agent-panel-presented-width",
			`${safeWidth.toFixed(2)}px`,
		);
		resizeHandleRef.current?.setAttribute(
			"aria-valuenow",
			String(Math.round(clampAgentPanelWidth(safeWidth, window.innerWidth))),
		);
	}

	function currentPanelWidth() {
		const rendered = shell()
			?.querySelector<HTMLElement>(".agent-sidebar")
			?.getBoundingClientRect().width;
		return rendered && rendered > 0 ? rendered : panelWidth;
	}

	function cancelSettle() {
		const interrupted = settleMotionRef.current;
		if (settleFrameRef.current !== null)
			window.cancelAnimationFrame(settleFrameRef.current);
		settleFrameRef.current = null;
		settleMotionRef.current = null;
		shell()?.classList.remove("agent-sidebar-settling");
		return interrupted;
	}

	function settlePanelWidth(width: number, velocity: number) {
		cancelSettle();
		const root = shell();
		root?.style.removeProperty("--agent-panel-presented-width");
		writePanelWidth(width);
		const target = projectedPanelWidth(width, velocity, window.innerWidth);
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			writePanelWidth(target);
			setPanelWidth(target);
			localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(Math.round(target)));
			return;
		}
		shell()?.classList.add("agent-sidebar-settling");
		let position = width;
		let currentVelocity = velocity;
		settleMotionRef.current = { position, velocity: currentVelocity };
		let previous = performance.now();
		const frame = (now: number) => {
			const next = springStep(
				position,
				currentVelocity,
				target,
				(now - previous) / 1000,
			);
			previous = now;
			position = next.position;
			currentVelocity = next.velocity;
			settleMotionRef.current = { position, velocity: currentVelocity };
			writePanelWidth(position);
			if (Math.abs(position - target) < 0.25 && Math.abs(currentVelocity) < 2) {
				writePanelWidth(target);
				setPanelWidth(target);
				localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(Math.round(target)));
				settleFrameRef.current = null;
				settleMotionRef.current = null;
				shell()?.classList.remove("agent-sidebar-settling");
				return;
			}
			settleFrameRef.current = window.requestAnimationFrame(frame);
		};
		settleFrameRef.current = window.requestAnimationFrame(frame);
	}

	function startResize(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0 || collapsed || compact) return;
		const root = shell();
		if (!root) return;
		/* Read the rendered width, not the unresolved clamp() custom property.
		 * A new grab can therefore interrupt a spring from its visible position. */
		const width = currentPanelWidth();
		cancelSettle();
		writePanelWidth(width);
		root.style.removeProperty("--agent-panel-presented-width");
		resizeRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth: width,
			width,
			lastX: event.clientX,
			lastAt: event.timeStamp,
			velocity: 0,
		};
		root.classList.add("agent-sidebar-resizing");
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function resizePanel(event: PointerEvent<HTMLDivElement>) {
		const drag = resizeRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const width = clampAgentPanelWidth(
			drag.startWidth + drag.startX - event.clientX,
			window.innerWidth,
		);
		const elapsed = Math.max(8, event.timeStamp - drag.lastAt) / 1000;
		const sampleVelocity = -(event.clientX - drag.lastX) / elapsed;
		drag.velocity = drag.velocity * 0.65 + sampleVelocity * 0.35;
		drag.width = width;
		drag.lastX = event.clientX;
		drag.lastAt = event.timeStamp;
		writePanelWidth(width);
	}

	function finishResize(event: PointerEvent<HTMLDivElement>) {
		const drag = resizeRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		resizeRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		shell()?.classList.remove("agent-sidebar-resizing");
		settlePanelWidth(drag.width, drag.velocity);
	}

	function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
		if (compact || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const root = shell();
		if (!root) return;
		const current = currentPanelWidth();
		const maximum = clampAgentPanelWidth(Number.POSITIVE_INFINITY, window.innerWidth);
		const next = clampAgentPanelWidth(
			event.key === "Home"
				? AGENT_PANEL_MIN_WIDTH
				: event.key === "End"
					? maximum
					: current + (event.key === "ArrowLeft" ? 16 : -16),
			window.innerWidth,
		);
		event.preventDefault();
		cancelSettle();
		root.style.removeProperty("--agent-panel-presented-width");
		writePanelWidth(next);
		setPanelWidth(next);
		localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(Math.round(next)));
	}

	useLayoutEffect(() => {
		const stored = Number.parseFloat(localStorage.getItem(AGENT_PANEL_WIDTH_KEY) ?? "");
		const width = clampAgentPanelWidth(Number.isFinite(stored) ? stored :
			defaultAgentPanelWidth(window.innerWidth), window.innerWidth);
		writePanelWidth(width);
		setPanelWidth(width);
		const onResize = () => {
			setViewportWidth(window.innerWidth);
			cancelSettle();
			resizeRef.current = null;
			shell()?.classList.remove("agent-sidebar-resizing");
			shell()?.style.removeProperty("--agent-panel-presented-width");
			setPanelWidth(current => {
				const next = clampAgentPanelWidth(current, window.innerWidth);
				writePanelWidth(next);
				return next;
			});
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			cancelSettle();
			const root = shell();
			root?.style.removeProperty("--agent-panel-presented-width");
			root?.classList.remove("agent-sidebar-resizing", "agent-sidebar-settling");
		};
	}, []);

	useLayoutEffect(() => {
		const root = shell();
		if (!root) return;
		root.classList.toggle("agent-sidebar-compact", compact);
		root.classList.toggle("agent-sidebar-overlay-open", compact && !collapsed);
		if (!compact || collapsed) return;
		const main = root.querySelector<HTMLElement>(".browser-main-plane");
		const previouslyInert = main?.inert ?? false;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (main) main.inert = true;
		// A resize can turn an already focused Chat into a modal. Keep that
		// control focused; only move focus when it starts outside the panel.
		if (!previousFocus || !sidebarRef.current?.contains(previousFocus)) closeRef.current?.focus();
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onToggleAgent();
			} else if (event.key === "Tab") {
				const controls = [...(sidebarRef.current?.querySelectorAll<HTMLElement>(
					'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
				) ?? [])].filter(node => node.getClientRects().length > 0 && !node.closest("[inert]"));
				const first = controls[0];
				const last = controls.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault(); last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault(); first?.focus();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (main) main.inert = previouslyInert;
			root.classList.remove("agent-sidebar-overlay-open");
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [compact, collapsed]);

	useLayoutEffect(() => {
		const root = shell();
		if (!root) return;
		if (compact) {
			cancelSettle();
			root.style.removeProperty("--agent-panel-presented-width");
			previousCollapsedRef.current = collapsed;
			visibilityMountedRef.current = true;
			return;
		}
		if (!visibilityMountedRef.current) {
			visibilityMountedRef.current = true;
			previousCollapsedRef.current = collapsed;
			root.style.removeProperty("--agent-panel-presented-width");
			return;
		}
		const wasCollapsed = previousCollapsedRef.current;
		if (wasCollapsed === collapsed) return;
		previousCollapsedRef.current = collapsed;
		resizeRef.current = null;
		root.classList.remove("agent-sidebar-resizing");
		const interrupted = cancelSettle();
		const target = collapsed
			? 0
			: clampAgentPanelWidth(panelWidth, window.innerWidth);
		const start = interrupted?.position ?? (wasCollapsed ? 0 : panelWidth);
		let velocity = interrupted
			? handoffSpringVelocity(start, interrupted.velocity, target)
			: 0;

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			root.style.removeProperty("--agent-panel-presented-width");
			if (!collapsed) writePanelWidth(target);
			return;
		}

		root.classList.add("agent-sidebar-settling");
		writePresentedPanelWidth(start);
		let position = start;
		let previous = performance.now();
		settleMotionRef.current = { position, velocity };
		const frame = (now: number) => {
			const next = springStep(position, velocity, target, (now - previous) / 1_000);
			previous = now;
			position = next.position;
			velocity = next.velocity;
			settleMotionRef.current = { position, velocity };
			writePresentedPanelWidth(position);
			if (Math.abs(position - target) < 0.25 && Math.abs(velocity) < 2) {
				writePresentedPanelWidth(target);
				if (!collapsed) writePanelWidth(target);
				root.style.removeProperty("--agent-panel-presented-width");
				settleFrameRef.current = null;
				settleMotionRef.current = null;
				root.classList.remove("agent-sidebar-settling");
				return;
			}
			settleFrameRef.current = window.requestAnimationFrame(frame);
		};
		settleFrameRef.current = window.requestAnimationFrame(frame);
	}, [collapsed, compact]);

	const activeSession = sessions.find((session) => session.id === activeSessionId);
	const currentTaskTitle = activeSession
		? sessionTitleForDisplay(activeSession.title)
		: "New task";
	const projectName = agentWorkspaceName(activeSession?.workspaceRoot);
	const showProjectName = projectName.length > 0;
	const compactStatus = activeSession
		? {
				active: "Working",
				waiting: "Needs input",
				completed: "Complete",
				cancelled: "Cancelled",
				failed: "Needs recovery",
			}[activeSession.status]
		: "Ready";
	return (
		<>
			<aside
				ref={sidebarRef}
				role={compact ? "dialog" : undefined}
				aria-modal={compact && !collapsed ? true : undefined}
				className={`agent-sidebar ${compact ? "agent-sidebar-overlay" : ""} ${collapsed ? "is-collapsed" : ""}`}
				aria-label={`${agentName} chat`}
				aria-hidden={collapsed}
				inert={collapsed}
			>
				{!compact && <div
					ref={resizeHandleRef}
					className="agent-sidebar-resize-handle"
					role="separator"
					aria-label="Resize Agent panel"
					aria-orientation="vertical"
					aria-valuemin={AGENT_PANEL_MIN_WIDTH}
					aria-valuemax={Math.round(clampAgentPanelWidth(Number.POSITIVE_INFINITY, viewportWidth))}
					aria-valuenow={Math.round(panelWidth)}
					tabIndex={0}
					onPointerDown={startResize}
					onPointerMove={resizePanel}
					onPointerUp={finishResize}
					onPointerCancel={finishResize}
					onLostPointerCapture={finishResize}
					onKeyDown={resizeWithKeyboard}
				/>}
				<div className="agent-sidebar-header">
					<div className="agent-sidebar-drag" />
					<div className="agent-chat-toolbar">
						<button
							type="button"
							className="agent-sidebar-new"
							aria-label="New task"
							aria-keyshortcuts="Meta+N"
							title="New task"
							onClick={() => onNewAgent()}
						>
							<Icon name="plus" />
						</button>
						<div className="agent-chat-heading">
							<strong title={currentTaskTitle}>{currentTaskTitle}</strong>
							{showProjectName ? (
								<small title={projectName}>{projectName}</small>
							) : null}
						</div>
						<button
							type="button"
							className="agent-sidebar-expand"
							aria-label="Open Agent tab"
							title="Open Agent tab"
							onClick={onExpandChat}
						>
							<Icon name="expand" />
						</button>
						<button
							type="button"
							ref={closeRef}
							className="agent-sidebar-collapse"
							aria-label={compact ? "Close chat" : `Hide ${agentName}`}
							title={compact ? "Close chat" : `Hide ${agentName}`}
							onClick={onToggleAgent}
						>
							<Icon name={compact ? "close" : "chevron"} className="agent-sidebar-collapse-icon" />
							{compact && <span>Close</span>}
						</button>
					</div>
				</div>
				<div className="agent-sidebar-assist">{communicationAssistant}</div>
				<div className="agent-sidebar-main">
					<div className="agent-conversation-host">{children}</div>
				</div>
			</aside>
			<aside className="agent-compact-dock" aria-label={`${agentName} dock`}>
				<button
					type="button"
					className="agent-compact-entry"
					aria-label={`Open ${agentName} and continue ${currentTaskTitle}`}
					onClick={onToggleAgent}
				>
					<span
						className={`agent-compact-state ${activeSession?.status ?? "ready"}`}
						aria-hidden="true"
					/>
					<span className="agent-compact-copy">
						<strong>{currentTaskTitle}</strong>
						<small>{compactStatus}</small>
					</span>
					<Icon name="expand" />
				</button>
				<button
					type="button"
					className="agent-compact-new"
					aria-label={`Start a new task with ${agentName}`}
					aria-keyshortcuts="Meta+N"
					title="New task"
					onClick={() => {
						onNewAgent();
					}}
				>
					<Icon name="plus" />
				</button>
			</aside>
		</>
	);
}
