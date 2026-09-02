import type { AgentRun } from "@kestrel/shared-types";
import type { ReactNode } from "react";
import { Button, Status, type StatusTone } from "../../ui";
import { agentSessionRecency, agentSessionStatusLabel } from "../../../agent-workspace";
import { Icon } from "../../Icon";
import type {
	AgentNodeProjection,
	AgentSystemProjection,
} from "./agent-universe-model";

function statusTone(status: AgentNodeProjection["status"]): StatusTone {
	return status === "active"
		? "running"
		: status === "waiting"
			? "warning"
			: status === "failed"
				? "error"
				: status === "completed"
					? "verified"
					: "neutral";
}

function formatTimestamp(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? new Date(timestamp).toLocaleString([], {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: "Unknown";
}

function latestRun(runs: readonly AgentRun[] | undefined): AgentRun | undefined {
	return runs?.length
		? [...runs].sort(
				(left, right) =>
					Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
					left.id.localeCompare(right.id),
				)[0]
		: undefined;
}

function DefinitionRow({
	label,
	children,
	}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="agent-universe-inspector-row">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

export function AgentUniverseInspector({
	system,
	node,
	runs,
	runsLoading,
	runsError,
	pendingApprovals,
	onClose,
	onOpenSession,
	onOpenApprovals,
}: {
	system: AgentSystemProjection;
	node?: AgentNodeProjection;
	runs?: readonly AgentRun[];
	runsLoading: boolean;
	runsError?: string;
	pendingApprovals: number;
	onClose(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
}) {
	const inspected = node;
	const parent = inspected?.parentId
		? system.nodes.find((item) => item.id === inspected.parentId)
		: undefined;
	const run = latestRun(runs) ?? inspected?.latestRun;
	const title = inspected?.name ?? system.name;
	const status = inspected?.status ?? system.status;
	const openSessionId = inspected?.id ?? system.rootNodeId;

	return (
		<aside
			className="agent-universe-inspector"
			aria-label={inspected ? `Inspect ${inspected.name}` : `Inspect ${system.name}`}
		>
			<header className="agent-universe-inspector-header">
				<div>
					<p className="agent-universe-inspector-eyebrow">
						{inspected ? (inspected.id === system.rootNodeId ? "System root" : "Delegated session") : "Agent system"}
					</p>
					<h2>{title}</h2>
				</div>
				<button
					type="button"
					className="agent-universe-inspector-close"
					aria-label="Close inspector"
					onClick={onClose}
				>
					<Icon name="close" />
				</button>
			</header>

			<div className="agent-universe-inspector-status">
				<Status tone={statusTone(status)}>{agentSessionStatusLabel(status)}</Status>
				<span>
					Updated {agentSessionRecency(inspected?.updatedAt ?? system.lastActivityAt)}
				</span>
			</div>

			<dl className="agent-universe-inspector-details">
				{inspected ? (
					<>
						{parent ? <DefinitionRow label="Derived from">{parent.name}</DefinitionRow> : null}
						<DefinitionRow label="Depth">
							{inspected.depth === 0 ? "Root" : `Delegated · ${inspected.depth}`}
						</DefinitionRow>
						{inspected.workspaceName ? (
							<DefinitionRow label="Workspace">
								<span title={inspected.workspaceRoot}>{inspected.workspaceName}</span>
							</DefinitionRow>
						) : null}
						<DefinitionRow label="Created">{formatTimestamp(inspected.createdAt)}</DefinitionRow>
					</>
				) : (
					<>
						<DefinitionRow label="Root session">{system.name}</DefinitionRow>
						<DefinitionRow label="Sessions">{system.nodes.length}</DefinitionRow>
						{system.workspaceName ? (
							<DefinitionRow label="Workspace">{system.workspaceName}</DefinitionRow>
						) : null}
					</>
				)}
			</dl>

			{inspected?.allowedTools.length ? (
				<section className="agent-universe-inspector-section">
					<h3>Capabilities</h3>
					<ul className="agent-universe-tool-list">
						{inspected.allowedTools.slice(0, 8).map((tool) => (
							<li key={tool}>{tool}</li>
						))}
					</ul>
					{inspected.allowedTools.length > 8 ? (
						<small>{inspected.allowedTools.length - 8} more tool grants recorded</small>
					) : null}
				</section>
			) : null}

			{inspected && (runsLoading || runsError || run) ? (
				<section className="agent-universe-inspector-section">
					<h3>Routing</h3>
					{runsLoading ? <p>Reading the latest verified run…</p> : null}
					{runsError ? <p role="alert">{runsError}</p> : null}
					{run ? (
						<dl className="agent-universe-inspector-details agent-universe-routing-details">
							<DefinitionRow label="Model">{run.model}</DefinitionRow>
							<DefinitionRow label="Provider">
								{run.providerIds.filter((provider) => provider !== "auto").join(", ") || "Automatic routing"}
							</DefinitionRow>
							{run.reasoningEffort ? (
								<DefinitionRow label="Reasoning">{run.reasoningEffort}</DefinitionRow>
							) : null}
							<DefinitionRow label="Run status">{run.status.replaceAll("_", " ")}</DefinitionRow>
						</dl>
					) : null}
				</section>
			) : null}

			{!inspected ? (
				<section className="agent-universe-inspector-section">
					<h3>Delegation</h3>
					<p>
						{system.nodes.length === 1
							? "No delegated sessions are recorded for this system."
							: `${system.nodes.length - 1} delegated session${system.nodes.length - 1 === 1 ? "" : "s"} recorded.`}
					</p>
				</section>
			) : null}

			<footer className="agent-universe-inspector-actions">
				<Button variant="solid" size="compact" onClick={() => onOpenSession(openSessionId)}>
					Open task
					<Icon name="arrow" />
				</Button>
				{(status === "waiting" || pendingApprovals > 0) ? (
					<Button variant="quiet" size="compact" onClick={onOpenApprovals}>
						Review approvals
					</Button>
				) : null}
			</footer>
		</aside>
	);
}
