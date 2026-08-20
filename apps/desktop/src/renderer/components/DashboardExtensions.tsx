import type {
	CoreResponse,
	DashboardMetricSource,
	DashboardRoute,
	PluginSummary,
	RuntimeSession,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";

function metricValue(
	source: DashboardMetricSource,
	plugin: PluginSummary,
	snapshot: WorkspaceSnapshot,
	sessions: RuntimeSession[],
): string {
	switch (source) {
		case "agent-state":
			return snapshot.agentState.replaceAll("_", " ");
		case "pending-approvals":
			return String(
				snapshot.approvals.filter((approval) => approval.status === "pending")
					.length,
			);
		case "model-cost-today":
			return `$${snapshot.resourceUsage.modelCostToday.toFixed(2)}`;
		case "model-budget-daily":
			return `$${snapshot.resourceUsage.modelBudgetDaily.toFixed(2)}`;
		case "active-workers":
			return String(snapshot.resourceUsage.activeWorkers);
		case "maximum-workers":
			return String(snapshot.resourceUsage.maximumWorkers);
		case "runtime-sessions":
			return String(
				sessions.filter((session) =>
					["active", "waiting"].includes(session.status),
				).length,
			);
		case "plugin-version":
			return `v${plugin.version}`;
		case "plugin-capabilities":
			return String(plugin.interface?.capabilities.length ?? 0);
	}
}

export function DashboardExtensions({
	snapshot,
	sessions,
	onNavigate,
}: {
	snapshot: WorkspaceSnapshot;
	sessions: RuntimeSession[];
	onNavigate(page: DashboardRoute): void;
}) {
	const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let current = true;
		void window.kestrel.request({ type: "plugin-list" }).then((raw) => {
			if (!current) return;
			const response = raw as CoreResponse;
			if (response.ok) setPlugins(response.plugins ?? []);
			else
				setError(
					"error" in response
						? response.error
						: "Dashboard extensions could not be loaded.",
				);
		});
		return () => {
			current = false;
		};
	}, []);

	const contributions = (plugins ?? []).filter(
		(plugin) => plugin.enabled && plugin.dashboard,
	);

	return (
		<div className="page-frame dashboard-extensions">
			<header className="page-header">
				<h1>Extensions</h1>
			</header>

			{error && (
				<p className="inline-error" role="alert">
					{error}
				</p>
			)}
			{!plugins && !error && <p role="status">Loading extension panels…</p>}
			{plugins && contributions.length === 0 && (
				<section className="empty-state">
					<BrandMark />
					<h2>No dashboard panels enabled.</h2>
					<p>
						Install signed plugins with dashboard contributions in Settings,
						then enable them to show panels here.
					</p>
					<button
						className="button secondary"
						onClick={() => onNavigate("settings")}
					>
						Open plugin settings
					</button>
				</section>
			)}

			{contributions.map((plugin) => {
				const dashboard = plugin.dashboard!;
				return (
					<section
						className="dashboard-contribution"
						key={plugin.name}
						aria-labelledby={`dashboard-${plugin.name}`}
					>
						<header>
							<div>
								<span className="eyebrow">
									{plugin.interface?.displayName ?? plugin.name} · v
									{plugin.version}
								</span>
								<h2 id={`dashboard-${plugin.name}`}>{dashboard.title}</h2>
								<p>{dashboard.description}</p>
							</div>
							<span className="declarative-badge">Declarative only</span>
						</header>

						<div className="dashboard-panel-list">
							{dashboard.panels.map((panel) => (
								<article
									className={`dashboard-panel tone-${panel.tone}`}
									key={panel.id}
								>
									<div className="dashboard-panel-copy">
										<h3>{panel.title}</h3>
										{panel.description && <p>{panel.description}</p>}
										{panel.items.length > 0 && (
											<ul>
												{panel.items.map((item) => (
													<li key={item}>{item}</li>
												))}
											</ul>
										)}
									</div>
									<div className="dashboard-panel-data">
										{panel.metrics.length > 0 && (
											<dl>
												{panel.metrics.map((metric) => (
													<div key={`${metric.label}-${metric.source}`}>
														<dt>{metric.label}</dt>
														<dd>
															{metricValue(
																metric.source,
																plugin,
																snapshot,
																sessions,
															)}
														</dd>
													</div>
												))}
											</dl>
										)}
										{panel.actions.length > 0 && (
											<div className="button-row">
												{panel.actions.map((action) => (
													<button
														className="button secondary"
														key={`${action.label}-${action.page}`}
														onClick={() => onNavigate(action.page)}
													>
														{action.label}
													</button>
												))}
											</div>
										)}
									</div>
								</article>
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}
