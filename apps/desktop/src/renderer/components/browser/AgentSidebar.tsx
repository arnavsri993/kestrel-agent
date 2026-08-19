import type { ReactNode } from "react";
import type { AgentState, RuntimeSession, UserBrowserTab } from "@kestrel/shared-types";
import { Brand } from "./Brand";
import { Icon } from "../Icon";
import { Status, type StatusTone } from "../ui";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	recentSidebarSessions,
	sidebarReviewVisible,
} from "./agent-sidebar";

const agentStateMeta: Record<AgentState, { label: string; tone: StatusTone }> = {
	idle: { label: "Ready", tone: "verified" },
	observing: { label: "Reading", tone: "running" },
	working: { label: "Working", tone: "running" },
	waiting_approval: { label: "Needs approval", tone: "needs-approval" },
	paused: { label: "Paused", tone: "neutral" },
	offline: { label: "Offline", tone: "neutral" },
	error: { label: "Needs recovery", tone: "error" },
	updating: { label: "Updating", tone: "running" },
};

export function AgentSidebar({
	children,
	communicationAssistant,
	sessions,
	activeSessionId,
	activeTab,
	agentName,
	collapsed,
	agentState,
	pendingApprovals = 0,
	activeDestination,
	onNewAgent,
	onToggleAgent,
	onOpenSession,
	onNavigate,
	onReviewApprovals,
}: {
	children: ReactNode;
	communicationAssistant?: ReactNode;
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	activeTab?: UserBrowserTab;
	agentName: string;
	collapsed: boolean;
	agentState: AgentState;
	pendingApprovals?: number;
	activeDestination: string;
	onNewAgent(prompt?: string): void;
	onToggleAgent(): void;
	onOpenSession(sessionId: string): void;
	onNavigate(destination: "browser" | "agent" | "approvals" | "settings"): void;
	onReviewApprovals?(): void;
}) {
	const recentSessions = recentSidebarSessions(sessions);
	const activeSession = sessions.find((session) => session.id === activeSessionId);
	const stateMeta = agentStateMeta[agentState];
	const currentTaskTitle = activeSession
		? sessionTitleForDisplay(activeSession.title)
		: "New task";
	const showReview = Boolean(
		onReviewApprovals &&
			sidebarReviewVisible({
				agentState,
				pendingCount: pendingApprovals,
			}),
	);
	return (
		<aside
			className={`agent-sidebar ${collapsed ? "is-collapsed" : ""}`}
			aria-label={`${agentName} agent`}
			aria-hidden={collapsed}
			inert={collapsed}
		>
			<div className="agent-sidebar-header">
				<div className="agent-sidebar-drag" />
				<div className="agent-sidebar-identity">
					<Brand />
					<span className="agent-sidebar-agent-name">{agentName}</span>
					<button
						type="button"
						className="agent-sidebar-collapse"
						aria-label={`Minimize ${agentName}`}
						title={`Minimize ${agentName}`}
						onClick={onToggleAgent}
					>
						<Icon name="chevron" />
					</button>
				</div>
				<div className="agent-sidebar-actions">
					<button
						type="button"
						className="agent-new-button"
						aria-label="New task"
						aria-keyshortcuts="Meta+N"
						onClick={() => onNewAgent()}
					>
						<Icon name="agent" />
						<span>New task</span>
						<kbd>⌘ N</kbd>
					</button>
				</div>
				<section
					className={`agent-session-context state-${agentState}`}
					aria-label="Current task and agent state"
				>
					<div
						className="agent-context-line"
						title={activeTab?.url || "No page open"}
					>
						<Icon name="context" />
						<span>{activeTab?.url ? activeTab.title : "No page open"}</span>
					</div>
					<div className="agent-task-line">
						<strong className="agent-session-title" title={currentTaskTitle}>
							{currentTaskTitle}
						</strong>
						<Status tone={stateMeta.tone}>{stateMeta.label}</Status>
					</div>
					{showReview && (
						<button
							type="button"
							className="agent-approval-action"
							onClick={() => onReviewApprovals?.()}
						>
							<Icon name="alert-triangle-filled" />
							<span>Your decision is needed</span>
							<strong>Review</strong>
						</button>
					)}
				</section>
				{recentSessions.length > 0 && (
					<section className="agent-sidebar-history" aria-label="Recent">
						<div className="agent-sidebar-section-heading">
							<span>Recent</span>
						</div>
						<div className="agent-sidebar-history-list">
							{recentSessions.map((session) => (
								<button
									type="button"
									key={session.id}
									className={session.id === activeSessionId ? "active" : ""}
									aria-current={
										session.id === activeSessionId ? "page" : undefined
									}
									onClick={() => onOpenSession(session.id)}
								>
									<Icon name="chat" />
									<span>
										<strong>{sessionTitleForDisplay(session.title)}</strong>
									</span>
									<time dateTime={session.updatedAt}>
										{new Intl.DateTimeFormat(undefined, {
											month: "short",
											day: "numeric",
										}).format(new Date(session.updatedAt))}
									</time>
								</button>
							))}
						</div>
					</section>
				)}
			</div>
			<div className="agent-sidebar-assist">{communicationAssistant}</div>
			<div className="agent-conversation-host">{children}</div>
			<div className="agent-sidebar-footer">
				<nav aria-label="Kestrel destinations">
					{(
						[
							["browser", "Browser", "browser"],
							["agent", "Agent", "agent"],
							["approvals", "Approvals", "approvals"],
							["settings", "Settings", "settings"],
						] as const
					).map(([destination, label, icon]) => (
						<button
							type="button"
							key={destination}
							id={destination === "browser" ? "kestrel-browser-nav" : undefined}
							aria-label={label}
							aria-current={
								activeDestination === destination ? "page" : undefined
							}
							className={activeDestination === destination ? "active" : ""}
							onClick={() => onNavigate(destination)}
						>
							<Icon name={icon} />
							{destination === "approvals" && pendingApprovals > 0 && (
								<span className="agent-approval-dot" aria-hidden="true" />
							)}
							<span>{label}</span>
						</button>
					))}
				</nav>
			</div>
		</aside>
	);
}
