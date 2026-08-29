import type { ReactNode } from "react";
import type { RuntimeSession } from "@kestrel/shared-types";
import { agentWorkspaceName } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import { Icon } from "../Icon";

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
	const activeSession = sessions.find((session) => session.id === activeSessionId);
	const currentTaskTitle = activeSession
		? sessionTitleForDisplay(activeSession.title)
		: "New task";
	const projectName = agentWorkspaceName(activeSession?.workspaceRoot);
	const showProjectName = projectName.length > 0;
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
						aria-label="Open Agent tab"
						title="Open Agent tab"
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
						{showProjectName ? (
							<small title={projectName}>{projectName}</small>
						) : null}
					</div>
					<button
						type="button"
						className="agent-sidebar-collapse"
						aria-label={`Hide ${agentName}`}
						title={`Hide ${agentName}`}
						onClick={onToggleAgent}
					>
						<Icon name="chevron" className="agent-sidebar-collapse-icon" />
					</button>
				</div>
			</div>
			<div className="agent-sidebar-assist">{communicationAssistant}</div>
			<div className="agent-sidebar-main">
				<div className="agent-conversation-host">{children}</div>
			</div>
		</aside>
	);
}
