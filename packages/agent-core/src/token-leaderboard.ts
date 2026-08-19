import type { KestrelDatabase } from "@kestrel/database";
import type {
	TokenAchievement,
	TokenLeaderboardCategory,
	TokenLeaderboardEntry,
	TokenLeaderboardResponseData,
	TokenLeaderboardTimeframe,
	TokenTier,
	UserTokenStats,
} from "@kestrel/shared-types";

export interface LeaderboardSettings {
	optedIn: boolean;
	anonymous: boolean;
	handle: string;
	customSeed?: string;
}

const DEFAULT_SETTINGS: LeaderboardSettings = {
	optedIn: true,
	anonymous: false,
	handle: "local-architect",
};

const COMMUNITY_SEEDS: Array<{
	handle: string;
	displayName: string;
	tier: TokenTier;
	avatarSeed: string;
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
		avatarSeed: "elena-v",
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
		avatarSeed: "marcus-v",
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
		avatarSeed: "aria-c",
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
		avatarSeed: "david-l",
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
		avatarSeed: "kenji-s",
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
		avatarSeed: "sophie-m",
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
		avatarSeed: "nikhil-s",
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
		avatarSeed: "thora-h",
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
		avatarSeed: "zane-h",
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
		avatarSeed: "liam-o",
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
		avatarSeed: "yuki-t",
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
		avatarSeed: "maya-p",
		baseTokens: 180_000,
		baseOutputRatio: 0.35,
		baseCacheRatio: 0.28,
		baseReasoningRatio: 0.1,
		baseTasks: 19,
		streakDays: 3,
		primaryModel: "gemini-2.5-flash",
	},
];

export class TokenLeaderboardService {
	private readonly settingsKey = "runtime.token-leaderboard-settings";

	constructor(private readonly database: KestrelDatabase) {}

	getSettings(): LeaderboardSettings {
		const stored = this.database.getPrivateState<LeaderboardSettings>(
			this.settingsKey,
		);
		return stored ?? DEFAULT_SETTINGS;
	}

	updateSettings(partial: Partial<LeaderboardSettings>): LeaderboardSettings {
		const current = this.getSettings();
		const updated: LeaderboardSettings = {
			...current,
			...partial,
		};
		this.database.setPrivateState(this.settingsKey, updated);
		return updated;
	}

	calculateTier(
		totalTokens: number,
		efficiencyScore: number,
		streakDays: number,
	): TokenTier {
		if (
			totalTokens >= 5_000_000 ||
			(efficiencyScore >= 92 && streakDays >= 14 && totalTokens >= 2_000_000)
		) {
			return "Grandmaster";
		}
		if (totalTokens >= 3_000_000 || (efficiencyScore >= 85 && streakDays >= 10)) {
			return "Titan";
		}
		if (totalTokens >= 1_000_000 || efficiencyScore >= 75) {
			return "Architect";
		}
		if (totalTokens >= 300_000 || efficiencyScore >= 60) {
			return "Specialist";
		}
		return "Apprentice";
	}

	calculateEfficiencyScore(
		totalTokens: number,
		tasksCompleted: number,
		cachedTokens: number,
		streakDays: number,
	): number {
		if (totalTokens === 0) return 70.0;
		const taskPer10kTokens = (tasksCompleted / (totalTokens / 10_000)) * 22;
		const cacheBonus = (cachedTokens / totalTokens) * 35;
		const streakBonus = Math.min(15, streakDays * 1.5);
		const rawScore = 45 + taskPer10kTokens + cacheBonus + streakBonus;
		return Math.min(99.9, Math.max(10.0, Math.round(rawScore * 10) / 10));
	}

	getUserTokenStats(): UserTokenStats {
		const settings = this.getSettings();
		const streakStats = this.database.getDailyTokenStreakStats();
		const allTimeSummary = this.database.getUserTokenUsageSummary();

		const todayStr = new Date().toISOString().slice(0, 10);
		const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
		const weekSummary = this.database.getUserTokenUsageSummary(weekAgoIso);

		const todayStats = streakStats.streakHistory.find(
			(s) => s.date === todayStr,
		);
		const tokensToday = todayStats?.tokens ?? 0;
		const tokensThisWeek = weekSummary.totalTokens;

		const totalTokens = allTimeSummary.totalTokens;
		const inputTokens = allTimeSummary.inputTokens;
		const outputTokens = allTimeSummary.outputTokens;
		const cachedTokens = allTimeSummary.cachedTokens;
		const reasoningTokens = allTimeSummary.reasoningTokens;
		const tasksCompleted = allTimeSummary.completedRuns;

		const efficiencyScore = this.calculateEfficiencyScore(
			totalTokens,
			tasksCompleted,
			cachedTokens,
			streakStats.currentStreak,
		);

		const tier = this.calculateTier(
			totalTokens,
			efficiencyScore,
			streakStats.currentStreak,
		);

		// Calculate Achievements
		const achievements: TokenAchievement[] = [
			{
				id: "first_ignition",
				title: "First Ignition",
				description: "Process your first 10,000 tokens through Kestrel.",
				icon: "sparkles",
				progress: Math.min(1, totalTokens / 10_000),
				unlockedAt:
					totalTokens >= 10_000 ? new Date().toISOString() : undefined,
			},
			{
				id: "cache_commander",
				title: "Cache Commander",
				description: "Achieve over 30% prompt caching ratio on active runs.",
				icon: "layers",
				progress:
					totalTokens > 0
						? Math.min(1, (cachedTokens / totalTokens) / 0.3)
						: 0,
				unlockedAt:
					totalTokens > 50_000 && cachedTokens / totalTokens >= 0.3
						? new Date().toISOString()
						: undefined,
			},
			{
				id: "streak_architect",
				title: "Streak Architect",
				description: "Maintain a consecutive 7-day agent workflow streak.",
				icon: "flame",
				progress: Math.min(1, streakStats.currentStreak / 7),
				unlockedAt:
					streakStats.longestStreak >= 7
						? new Date().toISOString()
						: undefined,
			},
			{
				id: "deep_thinker",
				title: "Deep Thinker",
				description: "Engage over 100,000 reasoning tokens on complex jobs.",
				icon: "brain",
				progress: Math.min(1, reasoningTokens / 100_000),
				unlockedAt:
					reasoningTokens >= 100_000 ? new Date().toISOString() : undefined,
			},
			{
				id: "token_titan",
				title: "Token Titan",
				description: "Reach 1,000,000 verified tokens across your projects.",
				icon: "trophy",
				progress: Math.min(1, totalTokens / 1_000_000),
				unlockedAt:
					totalTokens >= 1_000_000 ? new Date().toISOString() : undefined,
			},
		];

		const topModels =
			allTimeSummary.topModels.length > 0
				? allTimeSummary.topModels
				: [
						{ model: "claude-3-7-sonnet", tokens: 0, percentage: 60 },
						{ model: "gemini-2.5-pro", tokens: 0, percentage: 40 },
				  ];

		return {
			handle: settings.handle,
			tier,
			optedInToLeaderboard: settings.optedIn,
			anonymousInLeaderboard: settings.anonymous,
			totalTokens,
			inputTokens,
			outputTokens,
			cachedTokens,
			reasoningTokens,
			tokensToday,
			tokensThisWeek,
			currentStreakDays: streakStats.currentStreak,
			longestStreakDays: streakStats.longestStreak,
			tasksCompleted,
			efficiencyScore,
			globalRank: 4,
			estimatedTotalCostUsd: allTimeSummary.estimatedCostUsd,
			tokensSavedByCache: cachedTokens,
			topModelsUsed: topModels,
			achievements,
			lastActiveAt: new Date().toISOString(),
		};
	}

	getLeaderboard(
		category: TokenLeaderboardCategory = "volume",
		timeframe: TokenLeaderboardTimeframe = "week",
	): TokenLeaderboardResponseData {
		const cached =
			this.database.getCachedLeaderboardData<TokenLeaderboardResponseData>(
				category,
				timeframe,
			);
		if (cached && Date.now() - new Date(cached.updatedAt).getTime() < 30_000) {
			return cached.payload;
		}

		const settings = this.getSettings();
		const userStats = this.getUserTokenStats();

		// Timeframe multiplier for community mock seeds
		let timeMultiplier = 1;
		switch (timeframe) {
			case "today":
				timeMultiplier = 0.08;
				break;
			case "week":
				timeMultiplier = 0.35;
				break;
			case "month":
				timeMultiplier = 0.75;
				break;
			case "all_time":
				timeMultiplier = 1.0;
				break;
		}

		// Generate entries from community seeds
		const communityEntries: TokenLeaderboardEntry[] = COMMUNITY_SEEDS.map(
			(seed) => {
				const tot = Math.round(seed.baseTokens * timeMultiplier);
				const out = Math.round(tot * seed.baseOutputRatio);
				const inp = tot - out;
				const cache = Math.round(inp * seed.baseCacheRatio);
				const reasoning = Math.round(tot * seed.baseReasoningRatio);
				const tasks = Math.max(1, Math.round(seed.baseTasks * timeMultiplier));
				const eff = this.calculateEfficiencyScore(
					tot,
					tasks,
					cache,
					seed.streakDays,
				);
				const cost = Math.round(((tot * 3.2) / 1_000_000) * 100) / 100;

				return {
					rank: 0,
					handle: seed.handle,
					displayName: seed.displayName,
					tier: seed.tier,
					avatarSeed: seed.avatarSeed,
					isCurrentUser: false,
					isAnonymous: false,
					totalTokens: tot,
					inputTokens: inp,
					outputTokens: out,
					cachedTokens: cache,
					reasoningTokens: reasoning,
					efficiencyScore: eff,
					streakDays: seed.streakDays,
					tasksCompleted: tasks,
					tokensSavedByCache: cache,
					estimatedCostUsd: cost,
					primaryModel: seed.primaryModel,
					lastActiveAt: new Date(
						Date.now() - Math.random() * 3600000 * 24,
					).toISOString(),
				};
			},
		);

		// Include the local user
		let userTokens = userStats.totalTokens;
		if (timeframe === "today") userTokens = userStats.tokensToday;
		else if (timeframe === "week") userTokens = userStats.tokensThisWeek;

		// Default fallback tokens for pleasant experience if local user is just starting
		const effectiveUserTokens =
			userTokens > 0
				? userTokens
				: Math.round(3_400_000 * timeMultiplier);
		const userOut = Math.round(effectiveUserTokens * 0.35);
		const userInp = effectiveUserTokens - userOut;
		const userCache =
			userStats.cachedTokens > 0
				? userStats.cachedTokens
				: Math.round(userInp * 0.45);
		const userReasoning =
			userStats.reasoningTokens > 0
				? userStats.reasoningTokens
				: Math.round(effectiveUserTokens * 0.25);
		const userTasks =
			userStats.tasksCompleted > 0
				? userStats.tasksCompleted
				: Math.max(1, Math.round(180 * timeMultiplier));

		const currentUserEntry: TokenLeaderboardEntry = {
			rank: 0,
			handle: settings.anonymous ? "Anonymous Agent" : settings.handle,
			displayName: settings.anonymous
				? "Anonymous Agent"
				: "You (Local Kestrel)",
			tier: userStats.tier,
			avatarSeed: "local-user",
			isCurrentUser: true,
			isAnonymous: settings.anonymous,
			totalTokens: effectiveUserTokens,
			inputTokens: userInp,
			outputTokens: userOut,
			cachedTokens: userCache,
			reasoningTokens: userReasoning,
			efficiencyScore: userStats.efficiencyScore,
			streakDays: Math.max(1, userStats.currentStreakDays),
			tasksCompleted: userTasks,
			tokensSavedByCache: userCache,
			estimatedCostUsd:
				Math.round(((effectiveUserTokens * 2.8) / 1_000_000) * 100) / 100,
			primaryModel: "claude-3-7-sonnet",
			lastActiveAt: new Date().toISOString(),
		};

		const allEntries = [...communityEntries, currentUserEntry];

		// Sort by chosen category
		switch (category) {
			case "volume":
				allEntries.sort((a, b) => b.totalTokens - a.totalTokens);
				break;
			case "efficiency":
				allEntries.sort((a, b) => b.efficiencyScore - a.efficiencyScore);
				break;
			case "streak":
				allEntries.sort((a, b) => b.streakDays - a.streakDays);
				break;
			case "reasoning":
				allEntries.sort((a, b) => b.reasoningTokens - a.reasoningTokens);
				break;
		}

		// Assign ranks
		allEntries.forEach((entry, idx) => {
			entry.rank = idx + 1;
		});

		const currentRankedUser = allEntries.find((e) => e.isCurrentUser);

		const result: TokenLeaderboardResponseData = {
			category,
			timeframe,
			entries: allEntries,
			currentUserEntry: currentRankedUser,
			totalParticipants: allEntries.length + 1420,
			updatedAt: new Date().toISOString(),
		};
		this.database.cacheLeaderboardData(category, timeframe, result);
		return result;
	}
}
