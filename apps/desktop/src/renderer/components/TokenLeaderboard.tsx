import type {
	CoreResponse,
	TokenLeaderboardCategory,
	TokenLeaderboardEntry,
	TokenLeaderboardResponseData,
	TokenLeaderboardTimeframe,
	UserTokenStats,
} from "@kestrel/shared-types";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function TokenLeaderboard() {
	const [category, setCategory] = useState<TokenLeaderboardCategory>("volume");
	const [timeframe, setTimeframe] = useState<TokenLeaderboardTimeframe>("week");
	const [stats, setStats] = useState<UserTokenStats | null>(null);
	const [board, setBoard] = useState<TokenLeaderboardResponseData | null>(null);
	const [busy, setBusy] = useState(false);
	const [handleInput, setHandleInput] = useState("");
	const [anonymousInput, setAnonymousInput] = useState(false);
	const [savedMessage, setSavedMessage] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		loadStats();
		loadLeaderboard(category, timeframe);
	}, [category, timeframe]);

	async function loadStats() {
		try {
			const res = (await window.kestrel.request({
				type: "token-stats-get",
			})) as CoreResponse;
			if (res.ok && res.tokenStats) {
				setStats(res.tokenStats);
				setHandleInput(res.tokenStats.handle);
				setAnonymousInput(res.tokenStats.anonymousInLeaderboard);
			}
		} catch (err) {
			console.error("Failed to load token stats", err);
		}
	}

	async function loadLeaderboard(
		cat: TokenLeaderboardCategory,
		time: TokenLeaderboardTimeframe,
	) {
		setBusy(true);
		try {
			const res = (await window.kestrel.request({
				type: "token-leaderboard-get",
				category: cat,
				timeframe: time,
			})) as CoreResponse;
			if (res.ok && res.tokenLeaderboard) {
				setBoard(res.tokenLeaderboard);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not fetch leaderboard.");
		} finally {
			setBusy(false);
		}
	}

	async function saveSettings() {
		setBusy(true);
		setSavedMessage("");
		try {
			const res = (await window.kestrel.request({
				type: "token-leaderboard-opt-in",
				enabled: true,
				handle: handleInput.trim() || "local-builder",
				anonymous: anonymousInput,
			})) as CoreResponse;
			if (res.ok && res.tokenStats) {
				setStats(res.tokenStats);
				setSavedMessage("Settings saved! Updated in live competition.");
				void loadLeaderboard(category, timeframe);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update settings.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="page-frame token-arena-view">
			<header className="page-header">
				<div className="arena-title-lockup">
					<BrandMark />
					<div>
						<h1>Token Arena & Leaderboard</h1>
						<p>
							Local-first token accounting, prompt efficiency indexing, and
							opt-in community competition.
						</p>
					</div>
				</div>
			</header>

			{/* ── Personal Stats Overview ── */}
			{stats && (
				<section className="arena-personal-strip">
					<div className="arena-stat-box">
						<span className="stat-label">Current Tier</span>
						<strong className={`tier-tag tier-${stats.tier.toLowerCase()}`}>
							{stats.tier}
						</strong>
						<small>Rank #{stats.globalRank ?? 4} Global</small>
					</div>

					<div className="arena-stat-box">
						<span className="stat-label">Active Streak</span>
						<strong className="signal-value">🔥 {stats.currentStreakDays} Days</strong>
						<small>Best: {stats.longestStreakDays} days</small>
					</div>

					<div className="arena-stat-box">
						<span className="stat-label">Total Volume</span>
						<strong>{formatTokens(stats.totalTokens)}</strong>
						<small>Today: {formatTokens(stats.tokensToday)}</small>
					</div>

					<div className="arena-stat-box">
						<span className="stat-label">Efficiency ROI</span>
						<strong className="efficiency-value">{stats.efficiencyScore.toFixed(1)}%</strong>
						<small>Cache saved: {formatTokens(stats.tokensSavedByCache)}</small>
					</div>
				</section>
			)}

			{/* ── Controls Strip ── */}
			<section className="arena-filter-strip">
				<div className="arena-filter-group">
					<label>Category:</label>
					<div className="button-group">
						{(
							[
								["volume", "🏆 Volume"],
								["efficiency", "⚡ Efficiency"],
								["streak", "🔥 Streaks"],
								["reasoning", "🧠 Reasoning"],
							] as const
						).map(([val, label]) => (
							<button
								key={val}
								type="button"
								className={`pill-btn ${category === val ? "active" : ""}`}
								onClick={() => setCategory(val)}
							>
								{label}
							</button>
						))}
					</div>
				</div>

				<div className="arena-filter-group">
					<label>Timeframe:</label>
					<div className="button-group">
						{(
							[
								["today", "Today"],
								["week", "This Week"],
								["month", "This Month"],
								["all_time", "All-Time"],
							] as const
						).map(([val, label]) => (
							<button
								key={val}
								type="button"
								className={`pill-btn ${timeframe === val ? "active" : ""}`}
								onClick={() => setTimeframe(val)}
							>
								{label}
							</button>
						))}
					</div>
				</div>
			</section>

			{/* ── Leaderboard Table ── */}
			<section className="arena-table-card">
				{busy && <p className="loading-state">Updating standings…</p>}
				{board && (
					<table className="arena-table">
						<thead>
							<tr>
								<th>Rank</th>
								<th>Handle</th>
								<th>Tier</th>
								<th>Tokens</th>
								<th>Efficiency</th>
								<th>Streak</th>
								<th>Model</th>
							</tr>
						</thead>
						<tbody>
							{board.entries.map((entry) => (
								<tr
									key={entry.handle}
									className={entry.isCurrentUser ? "user-row" : ""}
								>
									<td>
										<span className={`rank-badge rank-${entry.rank}`}>
											{entry.rank === 1
												? "🥇 1"
												: entry.rank === 2
													? "🥈 2"
													: entry.rank === 3
														? "🥉 3"
														: `#${entry.rank}`}
										</span>
									</td>
									<td>
										<div className="handle-cell">
											<span className="avatar-chip">{entry.avatarSeed.slice(0, 2).toUpperCase()}</span>
											<div>
												<strong>{entry.displayName}</strong>
												<small>@{entry.handle}</small>
											</div>
										</div>
									</td>
									<td>
										<span className={`tier-pill tier-${entry.tier.toLowerCase()}`}>
											{entry.tier}
										</span>
									</td>
									<td>
										<strong>{formatTokens(entry.totalTokens)}</strong>
									</td>
									<td>
										<span className="eff-tag">
											{entry.efficiencyScore.toFixed(1)}%
										</span>
									</td>
									<td>🔥 {entry.streakDays}d</td>
									<td>
										<span className="model-tag">{entry.primaryModel}</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>

			{/* ── Preferences / Opt-in Settings Card ── */}
			<section className="arena-settings-card">
				<div className="card-header">
					<h3>Arena Participation & Privacy</h3>
					<p>
						Your prompts and context never leave your device. Only total token counts
						and efficiency scores are shared to the community board.
					</p>
				</div>

				<div className="settings-fields">
					<label>
						Public Handle
						<input
							type="text"
							value={handleInput}
							onChange={(e) => setHandleInput(e.target.value)}
							placeholder="e.g. prompt_ninja"
						/>
					</label>

					<label className="checkbox-row">
						<input
							type="checkbox"
							checked={anonymousInput}
							onChange={(e) => setAnonymousInput(e.target.checked)}
						/>
						Participate as Anonymous Agent
					</label>

					<button
						type="button"
						className="button button-primary"
						disabled={busy}
						onClick={() => void saveSettings()}
					>
						Save Arena Preferences
					</button>

					{savedMessage && <p className="success-tag">{savedMessage}</p>}
					{error && <p className="error-tag">{error}</p>}
				</div>
			</section>
		</div>
	);
}
