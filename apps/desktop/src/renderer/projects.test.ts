import type { RuntimeSession, WorkspaceGrant } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	projectChatSummary,
	projectChats,
	projectChatsForSidebar,
	sessionsWithoutProject,
} from "./projects";

const session = (
	id: string,
	updatedAt: string,
	workspaceRoot?: string,
): RuntimeSession => ({
	id,
	title: id,
	...(workspaceRoot ? { workspaceRoot } : {}),
	allowedTools: [],
	status: "completed",
	checkpoints: [],
	createdAt: updatedAt,
	updatedAt,
});

const projects: WorkspaceGrant[] = [
	{ path: "/work/alpha", name: "Alpha" },
	{ path: "/work/beta", name: "Beta", available: false },
];

describe("project chat grouping", () => {
	it("groups chats by their durable project folder and sorts by activity", () => {
		const chats = [
			session("alpha-old", "2026-08-10T12:00:00.000Z", "/work/alpha"),
			session("alpha-new", "2026-08-11T12:00:00.000Z", "/work/alpha"),
			session("beta", "2026-08-12T12:00:00.000Z", "/work/beta"),
		];

		expect(projectChats(chats, "/work/alpha").map(({ id }) => id)).toEqual([
			"alpha-new",
			"alpha-old",
		]);
		expect(projectChatSummary(chats, "/work/alpha")).toBe("2 chats");
	});

	it("limits sidebar previews without losing the full project list", () => {
		const chats = Array.from({ length: 6 }, (_, index) =>
			session(
				`alpha-${index}`,
				`2026-08-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`,
				"/work/alpha",
			),
		);

		expect(projectChatsForSidebar(chats, "/work/alpha")).toHaveLength(5);
		expect(projectChats(chats, "/work/alpha")).toHaveLength(6);
	});

	it("keeps standalone and unknown-folder chats in Recent tasks", () => {
		const chats = [
			session("alpha", "2026-08-10T12:00:00.000Z", "/work/alpha"),
			session("standalone", "2026-08-11T12:00:00.000Z"),
			session("old-folder", "2026-08-12T12:00:00.000Z", "/work/removed"),
		];

		expect(
			sessionsWithoutProject(chats, projects).map(({ id }) => id),
		).toEqual(["old-folder", "standalone"]);
	});
});
