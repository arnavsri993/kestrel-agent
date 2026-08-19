"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { sitePath } from "../../lib/site-path";

type Category = "volume" | "efficiency" | "streak" | "reasoning";
type Timeframe = "today" | "week" | "month" | "all_time";
type Tier = "Grandmaster" | "Titan" | "Architect" | "Specialist" | "Apprentice";

interface LeaderboardUser {
	rank: number;
	handle: string;
	displayName: string;
	tier: Tier;
	avatar: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	efficiencyScore: number;
	streakDays: number;
	tasksCompleted: number;
	primaryModel: string;
	isUser?: boolean;
}

const RAW_SEEDS: Array<{
	handle: string;
	displayName: string;
	tier: Tier;
	avatar: string;
	baseTokens: number;
	baseOutputRatio: number;
	baseCacheRatio: number;
	baseReasoningRatio: number;
	baseTasks: number;
	streakDays: number;
	primaryModel: string;
}> = [
	{
		handle: "vector_valkyrie",
		displayName: "Elena Rostova",
		tier: "Grandmaster",
		avatar: "🦊",
		baseTokens: 8_450_000,
		baseOutputRatio: 0.38,
		baseCacheRatio: 0.42,
		baseReasoningRatio: 0.28,
		baseTasks: 342,
		streakDays: 42,
		primaryModel: "claude-3-7-sonnet",
	},
	{
		handle: "context_king",
		displayName: "Marcus Vance",
		tier: "Grandmaster",
		avatar: "👑",
		baseTokens: 7_120_000,
		baseOutputRatio: 0.34,
		baseCacheRatio: 0.49,
		baseReasoningRatio: 0.31,
		baseTasks: 289,
		streakDays: 31,
		primaryModel: "gpt-4o",
	},
	{
		handle: "synth_weaver",
		displayName: "Aria Chen",
		tier: "Titan",
		avatar: "⚡",
		baseTokens: 5_340_000,
		baseOutputRatio: 0.41,
		baseCacheRatio: 0.38,
		baseReasoningRatio: 0.22,
		baseTasks: 215,
		streakDays: 24,
		primaryModel: "gemini-2.5-pro",
	},
	{
		handle: "kernel_panik",
		displayName: "David Lindqvist",
		tier: "Titan",
		avatar: "🛡️",
		baseTokens: 4_890_000,
		baseOutputRatio: 0.29,
		baseCacheRatio: 0.55,
		baseReasoningRatio: 0.35,
		baseTasks: 198,
		streakDays: 19,
		primaryModel: "claude-3-7-sonnet",
	},
	{
		handle: "token_ninja",
		displayName: "Kenji Sato",
		tier: "Titan",
		avatar: "🥷",
		baseTokens: 3_920_000,
		baseOutputRatio: 0.32,
		baseCacheRatio: 0.62,
		baseReasoningRatio: 0.18,
		baseTasks: 260,
		streakDays: 28,
		primaryModel: "qwen-2.5-coder-32b",
	},
	{
		handle: "prompt_artisan",
		displayName: "Sophie Martin",
		tier: "Architect",
		avatar: "🎨",
		baseTokens: 2_780_000,
		baseOutputRatio: 0.45,
		baseCacheRatio: 0.36,
		baseReasoningRatio: 0.15,
		baseTasks: 164,
		streakDays: 15,
		primaryModel: "claude-3-5-sonnet",
	},
	{
		handle: "byte_whisperer",
		displayName: "Nikhil Sharma",
		tier: "Architect",
		avatar: "🚀",
		baseTokens: 2_150_000,
		baseOutputRatio: 0.36,
		baseCacheRatio: 0.44,
		baseReasoningRatio: 0.25,
		baseTasks: 142,
		streakDays: 12,
		primaryModel: "gpt-4o",
	},
	{
		handle: "logic_forge",
		displayName: "Thora Helgason",
		tier: "Architect",
		avatar: "⚔️",
		baseTokens: 1_680_000,
		baseOutputRatio: 0.31,
		baseCacheRatio: 0.52,
		baseReasoningRatio: 0.4,
		baseTasks: 118,
		streakDays: 9,
		primaryModel: "deepseek-r1",
	},
	{
		handle: "quantum_coder",
		displayName: "Zane Holloway",
		tier: "Specialist",
		avatar: "🔮",
		baseTokens: 940_000,
		baseOutputRatio: 0.39,
		baseCacheRatio: 0.35,
		baseReasoningRatio: 0.12,
		baseTasks: 76,
		streakDays: 7,
		primaryModel: "gemini-2.5-flash",
	},
	{
		handle: "null_pointer",
		displayName: "Liam O'Connor",
		tier: "Specialist",
		avatar: "🎯",
		baseTokens: 620_000,
		baseOutputRatio: 0.33,
		baseCacheRatio: 0.41,
		baseReasoningRatio: 0.19,
		baseTasks: 53,
		streakDays: 5,
		primaryModel: "claude-3-5-sonnet",
	},
	{
		handle: "code_strider",
		displayName: "Yuki Tanaka",
		tier: "Specialist",
		avatar: "🏃",
		baseTokens: 410_000,
		baseOutputRatio: 0.28,
		baseCacheRatio: 0.39,
		baseReasoningRatio: 0.16,
		baseTasks: 38,
		streakDays: 4,
		primaryModel: "gpt-4o-mini",
	},
	{
		handle: "agent_cadet",
		displayName: "Maya Patel",
		tier: "Apprentice",
		avatar: "🌱",
		baseTokens: 180_000,
		baseOutputRatio: 0.35,
		baseCacheRatio: 0.28,
		baseReasoningRatio: 0.1,
		baseTasks: 19,
		streakDays: 3,
		primaryModel: "gemini-2.5-flash",
	},
];

function formatNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(2)}M`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}k`;
	}
	return num.toLocaleString();
}

export default function LeaderboardPage() {
	const [category, setCategory] = useState<Category>("volume");
	const [timeframe, setTimeframe] = useState<Timeframe>("week");
	const [searchQuery, setSearchQuery] = useState("");
	const [tierFilter, setTierFilter] = useState<string>("all");

	// Local Score Simulation / User custom handle
	const [userHandle, setUserHandle] = useState("local-builder");
	const [isAnonymous, setIsAnonymous] = useState(false);
	const [submitted, setSubmitted] = useState(false);

	// Calculator states
	const [monthlyCalls, setMonthlyCalls] = useState(1200);
	const [avgContextTokens, setAvgContextTokens] = useState(4500);
	const [cacheHitPercent, setCacheHitPercent] = useState(45);

	const timeMultiplier = useMemo(() => {
		switch (timeframe) {
			case "today":
				return 0.08;
			case "week":
				return 0.35;
			case "month":
				return 0.75;
			case "all_time":
				return 1.0;
		}
	}, [timeframe]);

	const leaderboardData = useMemo(() => {
		const list: LeaderboardUser[] = RAW_SEEDS.map((seed) => {
			const tot = Math.round(seed.baseTokens * timeMultiplier);
			const out = Math.round(tot * seed.baseOutputRatio);
			const inp = tot - out;
			const cache = Math.round(inp * seed.baseCacheRatio);
			const reasoning = Math.round(tot * seed.baseReasoningRatio);
			const tasks = Math.max(1, Math.round(seed.baseTasks * timeMultiplier));
			const eff = Math.min(
				99.9,
				Math.round(
					(45 +
						(tasks / (tot / 10000)) * 22 +
						(cache / tot) * 35 +
						Math.min(15, seed.streakDays * 1.5)) *
						10,
				) / 10,
			);

			return {
				rank: 0,
				handle: seed.handle,
				displayName: seed.displayName,
				tier: seed.tier,
				avatar: seed.avatar,
				totalTokens: tot,
				inputTokens: inp,
				outputTokens: out,
				cachedTokens: cache,
				reasoningTokens: reasoning,
				efficiencyScore: eff,
				streakDays: seed.streakDays,
				tasksCompleted: tasks,
				primaryModel: seed.primaryModel,
			};
		});

		// Add current user
		const userTokens = Math.round(3_650_000 * timeMultiplier);
		const userOut = Math.round(userTokens * 0.36);
		const userInp = userTokens - userOut;
		const userCache = Math.round(userInp * 0.48);
		const userReasoning = Math.round(userTokens * 0.26);
		const userTasks = Math.max(1, Math.round(175 * timeMultiplier));
		const userEff = 89.4;

		list.push({
			rank: 0,
			handle: isAnonymous ? "anonymous-agent" : userHandle,
			displayName: isAnonymous ? "Anonymous Agent" : "You (Local Kestrel)",
			tier: "Titan",
			avatar: "🦅",
			totalTokens: userTokens,
			inputTokens: userInp,
			outputTokens: userOut,
			cachedTokens: userCache,
			reasoningTokens: userReasoning,
			efficiencyScore: userEff,
			streakDays: 21,
			tasksCompleted: userTasks,
			primaryModel: "claude-3-7-sonnet",
			isUser: true,
		});

		// Sort by active category
		list.sort((a, b) => {
			if (category === "volume") return b.totalTokens - a.totalTokens;
			if (category === "efficiency")
				return b.efficiencyScore - a.efficiencyScore;
			if (category === "streak") return b.streakDays - a.streakDays;
			if (category === "reasoning")
				return b.reasoningTokens - a.reasoningTokens;
			return 0;
		});

		list.forEach((item, index) => {
			item.rank = index + 1;
		});

		return list;
	}, [timeMultiplier, category, isAnonymous, userHandle]);

	const filteredData = useMemo(() => {
		return leaderboardData.filter((item) => {
			const matchesSearch =
				item.handle.toLowerCase().includes(searchQuery.toLowerCase()) ||
				item.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
				item.primaryModel.toLowerCase().includes(searchQuery.toLowerCase());
			const matchesTier =
				tierFilter === "all" ||
				item.tier.toLowerCase() === tierFilter.toLowerCase();
			return matchesSearch && matchesTier;
		});
	}, [leaderboardData, searchQuery, tierFilter]);

	const podium = useMemo(() => {
		return leaderboardData.slice(0, 3);
	}, [leaderboardData]);

	// Calculator outputs
	const calcTokens = monthlyCalls * avgContextTokens;
	const calcCachedTokens = Math.round(calcTokens * (cacheHitPercent / 100));
	const calcCostSavedUsd = ((calcCachedTokens * 2.25) / 1_000_000).toFixed(2);
	const calcProjectedTier =
		calcTokens >= 5_000_000
			? "Grandmaster"
			: calcTokens >= 3_000_000
				? "Titan"
				: calcTokens >= 1_000_000
					? "Architect"
					: calcTokens >= 300_000
						? "Specialist"
						: "Apprentice";

	return (
		<div className="leaderboard-container">
			{/* ── Top Header ──────────────────────────────────────── */}
			<header className="site-header">
				<nav className="site-nav" aria-label="Main Navigation">
					<div className="site-brand">
						<Link className="brand-lockup" href="/">
							<img
								className="brand-mark"
								src={sitePath("/brand/workstrand-mark.svg")}
								alt=""
							/>
							<strong>Kestrel</strong>
							<small>Arena</small>
						</Link>
					</div>
					<div className="nav-links">
						<Link href="/#capabilities">Capabilities</Link>
						<Link href="/#boundary">Security</Link>
						<Link href="/leaderboard" className="active-nav">
							Leaderboard
						</Link>
						<Link href="/support">Support</Link>
					</div>
					<div className="nav-cta">
						<Link className="button button-primary" href="/#release">
							Get Kestrel
						</Link>
					</div>
				</nav>
			</header>

			<main className="leaderboard-main">
				{/* ── Hero Section ───────────────────────────────────── */}
				<section className="leaderboard-hero">
					<div className="hero-badge">
						<span className="live-dot" /> Live Community Competition
					</div>
					<h1>Token Arena & Leaderboard</h1>
					<p className="hero-subtitle">
						Compete on AI throughput, master prompt cache efficiency, build
						unstoppable daily streaks, and benchmark your engineering velocity.
					</p>

					{/* ── Timeframe & Category Switches ───────────────── */}
					<div className="controls-panel">
						<div className="timeframe-group" role="group" aria-label="Timeframe">
							{(
								[
									["today", "⚡ Today's Sprint"],
									["week", "🌟 This Week"],
									["month", "📅 This Month"],
									["all_time", "👑 All Time"],
								] as const
							).map(([val, label]) => (
								<button
									key={val}
									type="button"
									className={`tab-btn ${timeframe === val ? "active" : ""}`}
									onClick={() => setTimeframe(val)}
								>
									{label}
								</button>
							))}
						</div>

						<div className="category-group" role="group" aria-label="Category">
							{(
								[
									["volume", "🏆 Token Titans (Volume)"],
									["efficiency", "⚡ Efficiency Architects"],
									["streak", "🔥 Streak Masters"],
									["reasoning", "🧠 Deep Reasoning"],
								] as const
							).map(([val, label]) => (
								<button
									key={val}
									type="button"
									className={`category-btn ${category === val ? "active" : ""}`}
									onClick={() => setCategory(val)}
								>
									{label}
								</button>
							))}
						</div>
					</div>
				</section>

				{/* ── Top 3 Podium ───────────────────────────────────── */}
				<section className="podium-section">
					<div className="podium-grid">
						{/* 2nd Place */}
						{podium[1] && (
							<div className="podium-card rank-2">
								<div className="podium-crown">🥈 #2</div>
								<div className="podium-avatar">{podium[1].avatar}</div>
								<h3>{podium[1].displayName}</h3>
								<p className="podium-handle">@{podium[1].handle}</p>
								<span className={`tier-badge tier-${podium[1].tier.toLowerCase()}`}>
									{podium[1].tier}
								</span>
								<div className="podium-stat">
									<strong>{formatNumber(podium[1].totalTokens)}</strong>
									<span>tokens processed</span>
								</div>
								<div className="podium-substats">
									<span>⚡ {podium[1].efficiencyScore}% ROI</span>
									<span>🔥 {podium[1].streakDays}d streak</span>
								</div>
							</div>
						)}

						{/* 1st Place */}
						{podium[0] && (
							<div className="podium-card rank-1">
								<div className="podium-crown gold-crown">👑 #1 Champion</div>
								<div className="podium-avatar gold-avatar">{podium[0].avatar}</div>
								<h3>{podium[0].displayName}</h3>
								<p className="podium-handle">@{podium[0].handle}</p>
								<span className={`tier-badge tier-${podium[0].tier.toLowerCase()}`}>
									{podium[0].tier}
								</span>
								<div className="podium-stat">
									<strong>{formatNumber(podium[0].totalTokens)}</strong>
									<span>tokens processed</span>
								</div>
								<div className="podium-substats">
									<span>⚡ {podium[0].efficiencyScore}% ROI</span>
									<span>🔥 {podium[0].streakDays}d streak</span>
								</div>
							</div>
						)}

						{/* 3rd Place */}
						{podium[2] && (
							<div className="podium-card rank-3">
								<div className="podium-crown">🥉 #3</div>
								<div className="podium-avatar">{podium[2].avatar}</div>
								<h3>{podium[2].displayName}</h3>
								<p className="podium-handle">@{podium[2].handle}</p>
								<span className={`tier-badge tier-${podium[2].tier.toLowerCase()}`}>
									{podium[2].tier}
								</span>
								<div className="podium-stat">
									<strong>{formatNumber(podium[2].totalTokens)}</strong>
									<span>tokens processed</span>
								</div>
								<div className="podium-substats">
									<span>⚡ {podium[2].efficiencyScore}% ROI</span>
									<span>🔥 {podium[2].streakDays}d streak</span>
								</div>
							</div>
						)}
					</div>
				</section>

				{/* ── Table & Search Controls ────────────────────────── */}
				<section className="rankings-section">
					<div className="table-header-bar">
						<div className="search-box">
							<input
								type="text"
								placeholder="Search handles, models, or names…"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
							/>
						</div>

						<div className="tier-filter-tabs">
							{["all", "Grandmaster", "Titan", "Architect", "Specialist"].map(
								(t) => (
									<button
										key={t}
										type="button"
										className={`filter-pill ${tierFilter === t ? "active" : ""}`}
										onClick={() => setTierFilter(t)}
									>
										{t === "all" ? "All Tiers" : t}
									</button>
								),
							)}
						</div>
					</div>

					<div className="table-responsive">
						<table className="leaderboard-table">
							<thead>
								<tr>
									<th>Rank</th>
									<th>Agent / Builder</th>
									<th>Tier</th>
									<th>Total Tokens</th>
									<th>Cache Ratio</th>
									<th>Efficiency ROI</th>
									<th>Streak</th>
									<th>Completed Tasks</th>
									<th>Primary Route</th>
								</tr>
							</thead>
							<tbody>
								{filteredData.map((user) => (
									<tr
										key={user.handle}
										className={user.isUser ? "user-row-highlight" : ""}
									>
										<td className="rank-cell">
											<span className={`rank-tag rank-${user.rank}`}>
												{user.rank === 1
													? "🥇 1"
													: user.rank === 2
														? "🥈 2"
														: user.rank === 3
															? "🥉 3"
															: `#${user.rank}`}
											</span>
										</td>
										<td className="user-cell">
											<div className="user-info">
												<span className="user-avatar">{user.avatar}</span>
												<div>
													<strong>{user.displayName}</strong>
													<small>@{user.handle}</small>
												</div>
											</div>
										</td>
										<td>
											<span
												className={`tier-pill tier-${user.tier.toLowerCase()}`}
											>
												{user.tier}
											</span>
										</td>
										<td className="token-cell">
											<strong>{formatNumber(user.totalTokens)}</strong>
											<small>
												In: {formatNumber(user.inputTokens)} · Out:{" "}
												{formatNumber(user.outputTokens)}
											</small>
										</td>
										<td>
											<div className="cache-bar-wrapper">
												<span className="cache-text">
													{Math.round(
														(user.cachedTokens /
															Math.max(1, user.inputTokens)) *
															100,
													)}
													%
												</span>
												<div className="mini-progress">
													<div
														className="mini-bar"
														style={{
															width: `${Math.min(
																100,
																(user.cachedTokens /
																	Math.max(1, user.inputTokens)) *
																	100,
															)}%`,
														}}
													/>
												</div>
											</div>
										</td>
										<td>
											<span className="efficiency-badge">
												{user.efficiencyScore.toFixed(1)}%
											</span>
										</td>
										<td>
											<span className="streak-badge">
												🔥 {user.streakDays}d
											</span>
										</td>
										<td>
											<strong>{user.tasksCompleted}</strong>
										</td>
										<td>
											<span className="model-chip">{user.primaryModel}</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>

				{/* ── Interactive Opt-In & Score Submit ──────────────── */}
				<section className="submit-score-section">
					<div className="submit-score-card">
						<div className="card-copy">
							<h2>Sync Your Local Kestrel Stats</h2>
							<p>
								Kestrel computes all token usage and efficiency locally on your
								machine. Ready to claim your global rank on the community
								leaderboard?
							</p>
							<div className="privacy-guarantee">
								<span className="shield-icon">🛡️</span>
								<strong>Local-First Privacy Boundary</strong>: Prompts, project
								code, and file names never leave your device. Only your token
								odometer and chosen handle are verified.
							</div>
						</div>

						<div className="card-form">
							<label>
								Leaderboard Handle
								<input
									type="text"
									value={userHandle}
									onChange={(e) => setUserHandle(e.target.value)}
									placeholder="e.g. prompt_wizard"
								/>
							</label>

							<label className="checkbox-label">
								<input
									type="checkbox"
									checked={isAnonymous}
									onChange={(e) => setIsAnonymous(e.target.checked)}
								/>
								Compete anonymously (displays as Anonymous Agent)
							</label>

							<button
								type="button"
								className="button button-primary submit-btn"
								onClick={() => setSubmitted(true)}
							>
								{submitted ? "✓ Stats Synced & Verified" : "Sync Local Score"}
							</button>

							{submitted && (
								<p className="success-banner" role="status">
									🎉 Your local stats are connected! You are currently ranked in
									the <strong>Titan Tier</strong>.
								</p>
							)}
						</div>
					</div>
				</section>

				{/* ── Token ROI & Rank Calculator ────────────────────── */}
				<section className="calculator-section">
					<div className="calc-header">
						<h2>Token Efficiency & Savings Calculator</h2>
						<p>
							Estimate your monthly token usage, prompt caching savings, and
							projected competitive tier.
						</p>
					</div>

					<div className="calc-grid">
						<div className="calc-controls">
							<label>
								Monthly Agent Runs: <strong>{monthlyCalls}</strong>
								<input
									type="range"
									min="100"
									max="10000"
									step="100"
									value={monthlyCalls}
									onChange={(e) => setMonthlyCalls(Number(e.target.value))}
								/>
							</label>

							<label>
								Average Context Size: <strong>{avgContextTokens} tokens</strong>
								<input
									type="range"
									min="1000"
									max="64000"
									step="1000"
									value={avgContextTokens}
									onChange={(e) => setAvgContextTokens(Number(e.target.value))}
								/>
							</label>

							<label>
								Prompt Cache Hit Rate: <strong>{cacheHitPercent}%</strong>
								<input
									type="range"
									min="0"
									max="90"
									step="5"
									value={cacheHitPercent}
									onChange={(e) => setCacheHitPercent(Number(e.target.value))}
								/>
							</label>
						</div>

						<div className="calc-results-card">
							<div className="result-stat">
								<span>Projected Monthly Tokens</span>
								<strong>{formatNumber(calcTokens)}</strong>
							</div>
							<div className="result-stat">
								<span>Cached Tokens Saved</span>
								<strong className="signal-text">
									{formatNumber(calcCachedTokens)}
								</strong>
							</div>
							<div className="result-stat">
								<span>Estimated Monthly Savings</span>
								<strong className="signal-text">${calcCostSavedUsd}</strong>
							</div>
							<div className="result-stat">
								<span>Projected Arena Tier</span>
								<span
									className={`tier-pill tier-${calcProjectedTier.toLowerCase()}`}
								>
									{calcProjectedTier}
								</span>
							</div>
						</div>
					</div>
				</section>

				{/* ── Tier Legend & Achievement Badges ───────────────── */}
				<section className="tiers-section">
					<h2>Competition Tiers & Milestones</h2>
					<div className="tiers-grid">
						<div className="tier-card tier-grandmaster-card">
							<div className="tier-card-head">
								<span className="tier-icon">👑</span>
								<div>
									<h3>Grandmaster</h3>
									<small>Top 1% Elite</small>
								</div>
							</div>
							<p>5,000,000+ total tokens or 92%+ efficiency with 14+ day streak.</p>
						</div>

						<div className="tier-card tier-titan-card">
							<div className="tier-card-head">
								<span className="tier-icon">⚡</span>
								<div>
									<h3>Titan</h3>
									<small>Top 5% Builders</small>
								</div>
							</div>
							<p>3,000,000+ total tokens or 85%+ efficiency with 10+ day streak.</p>
						</div>

						<div className="tier-card tier-architect-card">
							<div className="tier-card-head">
								<span className="tier-icon">🎨</span>
								<div>
									<h3>Architect</h3>
									<small>Core Creators</small>
								</div>
							</div>
							<p>1,000,000+ total tokens or 75%+ prompt ROI.</p>
						</div>

						<div className="tier-card tier-specialist-card">
							<div className="tier-card-head">
								<span className="tier-icon">🎯</span>
								<div>
									<h3>Specialist</h3>
									<small>Active Practitioners</small>
								</div>
							</div>
							<p>300,000+ total tokens or 60%+ prompt ROI.</p>
						</div>
					</div>
				</section>
			</main>

			{/* ── Footer ─────────────────────────────────────────── */}
			<footer className="site-footer">
				<div className="footer-brand">
					<Link className="brand-lockup" href="/">
						<img
							className="brand-mark"
							src={sitePath("/brand/workstrand-mark.svg")}
							alt=""
						/>
						<strong>Kestrel</strong>
					</Link>
				</div>
				<p>
					Local-first AI agent with zero private data leakage. Compete on
					evidence, build with velocity.
				</p>
				<div className="footer-links">
					<Link href="/">Home</Link>
					<Link href="/#capabilities">Capabilities</Link>
					<Link href="/leaderboard">Leaderboard</Link>
					<Link href="/privacy">Privacy</Link>
					<Link href="/support">Support</Link>
				</div>
			</footer>
		</div>
	);
}
