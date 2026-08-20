import type { ReactNode } from "react";
import type { AgentState, RuntimeSession } from "@kestrel/shared-types";
import { agentWorkspaceName } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";
import { sidebarReviewVisible } from "./agent-sidebar";

export function AgentSidebar({
	children,
	communicationAssistant,
	workspace,
	sessions,
	activeSessionId,
	agentName,
	collapsed,
	agentState,
	pendingApprovals = 0,
	activeDestination,
	onNewAgent,
	onToggleAgent,
	onExpandChat,
	onNavigate,
	onReviewApprovals,
}: {
	children: ReactNode;
	communicationAssistant?: ReactNode;
	workspace?: ReactNode;
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	agentName: string;
	collapsed: boolean;
	agentState: AgentState;
	pendingApprovals?: number;
	activeDestination: string;
	onNewAgent(prompt?: string): void;
	onToggleAgent(): void;
	onExpandChat(): void;
	onNavigate(destination: "browser" | "agent" | "approvals" | "settings"): void;
	onReviewApprovals?(): void;
}) {
	const activeSession = sessions.find((session) => session.id === activeSessionId);
	const currentTaskTitle = activeSession
		? sessionTitleForDisplay(activeSession.title)
		: "New task";
	const projectName = agentWorkspaceName(activeSession?.workspaceRoot);
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
			aria-label={`${agentName} chat`}
			aria-hidden={collapsed}
			inert={collapsed}
		>
			<div className="agent-sidebar-header">
				<div className="agent-sidebar-drag" />
				<div className="agent-chat-toolbar">
					<button
						type="button"
						className="agent-sidebar-expand"
						aria-label="Open chat in the full window"
						title="Open chat in the full window"
						onClick={onExpandChat}
					>
						<Icon name="expand" />
					</button>
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
						<small title={projectName}>{projectName}</small>
					</div>
					<button
						type="button"
						className="agent-sidebar-collapse"
						aria-label={`Minimize ${agentName}`}
						title={`Minimize ${agentName}`}
						onClick={onToggleAgent}
					>
						<Icon name="chevron" className="agent-sidebar-collapse-icon" />
					</button>
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
			</div>
			<div className="agent-sidebar-assist">{communicationAssistant}</div>
			<div className="agent-sidebar-main">
				<div className="agent-full-page-workspace">{workspace}</div>
				<div className="agent-conversation-host">{children}</div>
			</div>
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
