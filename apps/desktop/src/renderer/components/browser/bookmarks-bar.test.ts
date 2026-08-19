import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { BookmarksBar, DEFAULT_BOOKMARKS } from "./BookmarksBar";

describe("BookmarksBar", () => {
  it("renders default bookmarks with icons and labels", () => {
    const onNavigate = vi.fn();
    const onCreateTab = vi.fn();
    const html = renderToStaticMarkup(
      createElement(BookmarksBar, {
        onNavigate,
        onCreateTab,
      }),
    );

    expect(html).toContain("Bookmarks bar");
    expect(html).toContain("Google");
    expect(html).toContain("GitHub");
    expect(html).toContain("YouTube");
    expect(html).toContain("bookmark-button");
  });

  it("renders bookmark star action when activeTab is provided", () => {
    const onNavigate = vi.fn();
    const onCreateTab = vi.fn();
    const html = renderToStaticMarkup(
      createElement(BookmarksBar, {
        activeTab: {
          id: "tab-1",
          title: "Documentation",
          url: "https://example.com/docs",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          discarded: false,
          crashed: false,
          createdAt: "2026-08-16T00:00:00.000Z",
          lastActiveAt: "2026-08-16T00:00:00.000Z",
        },
        onNavigate,
        onCreateTab,
      }),
    );

    expect(html).toContain("bookmark-star-action");
  });
});
