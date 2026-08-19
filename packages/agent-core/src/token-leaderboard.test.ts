import { KestrelDatabase } from "@kestrel/database";
import { describe, expect, it } from "vitest";
import { TokenLeaderboardService } from "./token-leaderboard";

describe("TokenLeaderboardService", () => {
	it("calculates tiers and efficiency scores correctly", () => {
		const database = new KestrelDatabase(
			":memory:",
			Buffer.alloc(32, "test-db-key"),
		);
		try {
			const service = new TokenLeaderboardService(database);

			expect(service.calculateTier(6_000_000, 95, 20)).toBe("Grandmaster");
			expect(service.calculateTier(3_500_000, 86, 12)).toBe("Titan");
			expect(service.calculateTier(1_200_000, 78, 5)).toBe("Architect");
			expect(service.calculateTier(400_000, 65, 3)).toBe("Specialist");
			expect(service.calculateTier(50_000, 50, 1)).toBe("Apprentice");

			const eff = service.calculateEfficiencyScore(100_000, 10, 40_000, 7);
			expect(eff).toBeGreaterThan(60);
			expect(eff).toBeLessThanOrEqual(100);
		} finally {
			database.close();
		}
	});

	it("returns sorted leaderboard entries across categories and timeframes", () => {
		const database = new KestrelDatabase(
			":memory:",
			Buffer.alloc(32, "test-db-key"),
		);
		try {
			const service = new TokenLeaderboardService(database);
			const volumeBoard = service.getLeaderboard("volume", "week");

			expect(volumeBoard.entries.length).toBeGreaterThan(5);
			expect(volumeBoard.entries[0]?.rank).toBe(1);
			expect(volumeBoard.entries[0]?.totalTokens).toBeGreaterThanOrEqual(
				volumeBoard.entries[1]?.totalTokens ?? 0,
			);

			const efficiencyBoard = service.getLeaderboard("efficiency", "all_time");
			expect(
				efficiencyBoard.entries[0]?.efficiencyScore,
			).toBeGreaterThanOrEqual(
				efficiencyBoard.entries[1]?.efficiencyScore ?? 0,
			);

			const streakBoard = service.getLeaderboard("streak", "month");
			expect(streakBoard.entries[0]?.streakDays).toBeGreaterThanOrEqual(
				streakBoard.entries[1]?.streakDays ?? 0,
			);
		} finally {
			database.close();
		}
	});

	it("manages user stats and privacy settings", () => {
		const database = new KestrelDatabase(
			":memory:",
			Buffer.alloc(32, "test-db-key"),
		);
		try {
			const service = new TokenLeaderboardService(database);

			service.updateSettings({
				handle: "cyber_phoenix",
				anonymous: true,
				optedIn: true,
			});

			const stats = service.getUserTokenStats();
			expect(stats.handle).toBe("cyber_phoenix");
			expect(stats.anonymousInLeaderboard).toBe(true);
			expect(stats.achievements).toHaveLength(5);
		} finally {
			database.close();
		}
	});
});
