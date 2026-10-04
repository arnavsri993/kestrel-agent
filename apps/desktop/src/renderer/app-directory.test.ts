import { describe, expect, it } from "vitest";
import { KESTREL_APP_PAGES } from "../utility/browser-app-pages";
import { commandDestinations, DIRECTORY_GROUPS, searchDestinations } from "./app-directory";

describe("app directory", () => {
  it("keeps every navigable workspace available exactly once", () => {
    const ids = commandDestinations.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.keys(KESTREL_APP_PAGES).filter(id => id !== "commands")) {
      expect(ids).toContain(id);
    }
    for (const item of commandDestinations) expect(DIRECTORY_GROUPS).toContain(item.group);
  });
  it("finds destinations by multiple words, category and legacy route names", () => {
    expect(searchDestinations(commandDestinations, "goals schedules").map(item => item.id)).toEqual(["work"]);
    expect(searchDestinations(commandDestinations, " LIBRARY ").map(item => item.id)).toEqual(["memory", "artifacts", "activity"]);
    expect(searchDestinations(commandDestinations, "artifacts").map(item => item.id)).toEqual(["artifacts"]);
    expect(searchDestinations(commandDestinations, "zzzz-no-match")).toEqual([]);
    expect(searchDestinations(commandDestinations, "  ")).toEqual(commandDestinations);
  });
});
