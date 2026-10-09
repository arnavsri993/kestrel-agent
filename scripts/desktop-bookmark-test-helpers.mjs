import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Shared by the broad browser journey and the focused source/package check.
// The fixture starts on a loaded Page one with a favicon and no bookmarks.
export async function exerciseSavedPages({
	page, application, origin, browserState, waitForBrowserState,
	waitForNativeView, packagedExecutable,
}) {
	let state;
	const agentSidebar = page.locator(".agent-sidebar");
	const agentToggle = page.locator("#browser-agent-toggle");
	const bookmarkTrigger = page.getByRole("button", {
		name: "Bookmark this page",
		exact: true,
	});
	await bookmarkTrigger.click();
	const bookmarkDialog = page.getByRole("dialog", { name: "Save bookmark" });
	await bookmarkDialog.waitFor();
	assert.deepEqual(
		await bookmarkDialog.locator(".bookmark-dialog-option-copy strong").allTextContents(),
		["Full link", "Suggested title", "Icon only"],
	);
	assert.equal(await bookmarkDialog.locator(".bookmark-dialog-option-preview").count(), 3);
	assert.equal(
		await bookmarkDialog.locator('input[type="radio"][value="full"]').isChecked(),
		true,
	);
	assert(
		(await bookmarkDialog.locator(".bookmark-dialog-preview-label").first().textContent())?.includes(
			`${origin}/one`,
		),
	);
	await bookmarkDialog.locator('input[type="radio"][value="title"]').check();
	assert.equal(
		(await bookmarkDialog.locator(".bookmark-dialog-preview-label").first().textContent())?.trim(),
		"Page one",
	);
	await bookmarkDialog.locator('input[type="radio"][value="icon"]').check();
	assert.equal(await bookmarkDialog.locator(".bookmark-dialog-preview-entry.icon-only").count(), 1);
	await bookmarkDialog.getByRole("button", { name: "New folder", exact: true }).click();
	await bookmarkDialog.getByPlaceholder("Folder name").fill("Reading");
	await bookmarkDialog.getByRole("button", { name: "Create", exact: true }).click();
	const bookmarkFolderSelect = bookmarkDialog.locator("#bookmark-folder-select");
	await page.waitForFunction(
		() => document.querySelector("#bookmark-folder-select")?.value !== "",
	);
	const createdFolderId = await bookmarkFolderSelect.inputValue();
	assert(createdFolderId);
	await bookmarkDialog.getByRole("button", { name: "Save bookmark", exact: true }).click();
	await bookmarkDialog.waitFor({ state: "detached" });
	state = await waitForBrowserState(
		(value) =>
			value.bookmarks.some(
				(bookmark) =>
					bookmark.url === `${origin}/one` &&
					bookmark.displayMode === "icon" &&
					bookmark.folderId === createdFolderId &&
					bookmark.faviconDataUrl?.startsWith("data:image/"),
			),
		"Bookmark presentation choice was not persisted",
	);
	await page.getByRole("button", { name: "New Tab", exact: true }).click();
	await page.locator(".browser-bookmarks-bar").waitFor();
	const folderTrigger = page.getByRole("button", { name: "Reading", exact: true });
	await folderTrigger.click();
	const folderMenu = page.getByRole("menu", { name: "Reading bookmarks" });
	await folderMenu.waitFor();
	assert.equal(await folderMenu.getByRole("menuitem", { name: "Open Page one" }).count(), 1);
	assert.equal(await folderMenu.locator("img").count(), 1);
	await page.keyboard.press("Escape");
	const bookmarksWindowGeometry = await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) =>
				!candidate.isDestroyed() &&
				!candidate.webContents.getURL().includes("petOverlay=1"),
		);
		if (!window) throw new Error("The Kestrel window is unavailable.");
		return { size: window.getSize(), minimum: window.getMinimumSize() };
	});
	const bookmarksWindowSize = bookmarksWindowGeometry.size;
	const bookmarksAgentWasOpen = (await agentToggle.getAttribute("aria-expanded")) === "true";
	// Exercise the library's <=760px pane breakpoint with navigation visible, without relying
	// on a docked Agent rail or the global <=720px header rule.
	const narrowBookmarksWindowWidth = 760;
	if (bookmarksWindowSize[0] !== narrowBookmarksWindowWidth) {
		await application.evaluate(
			({ BrowserWindow }, [width, height]) => {
				const window = BrowserWindow.getAllWindows().find(
					(candidate) =>
						!candidate.isDestroyed() &&
						!candidate.webContents.getURL().includes("petOverlay=1"),
				);
				if (!window) throw new Error("The Kestrel window is unavailable.");
				// Only this disposable fixture window is resized below the native
				// default minimum; keep the global header media query inactive.
				window.setMinimumSize(Math.min(width, window.getMinimumSize()[0]), window.getMinimumSize()[1]);
				window.setSize(width, height);
			},
			[narrowBookmarksWindowWidth, bookmarksWindowSize[1]],
		);
		await page.waitForFunction(
			(width) => innerWidth === width,
			narrowBookmarksWindowWidth,
		);
	}
	// Compact Agent owns the workspace. Return through its visible control
	// before looking for browser controls behind it; never force the click.
	if ((await agentToggle.getAttribute("aria-expanded")) === "true") {
		const closeChat = agentSidebar.getByRole("button", { name: /^(Close chat|Hide .+)$/ });
		if (await closeChat.isVisible()) {
			await closeChat.click();
		} else {
			// The legacy compact dock keeps the toolbar toggle visible while
			// the wide chat rail is hidden. Use that user-facing control.
			await agentToggle.click();
		}
	}
	await page.waitForFunction(() => {
		const plane = document.querySelector(".browser-main-plane");
		const sidebar = document.querySelector(".agent-sidebar");
		return document.querySelector("#browser-agent-toggle")?.getAttribute("aria-expanded") === "false" &&
			sidebar?.getAttribute("aria-hidden") === "true" && sidebar.inert &&
			plane && getComputedStyle(plane).visibility === "visible" && !plane.closest("[inert]");
	});
	await page.waitForFunction(() => !document.querySelector(".ai-browser-app")?.classList.contains("agent-sidebar-settling"));
	const manageBookmarks = page.getByRole("button", { name: "Manage bookmarks", exact: true });
	await manageBookmarks.focus();
	assert.equal(await manageBookmarks.evaluate(button => document.activeElement === button), true);
	await manageBookmarks.press("Enter");
	await page.getByRole("heading", { name: "Saved pages", exact: true }).waitFor();
	await page.waitForFunction(() => {
		const route = document.querySelector('.browser-app-page[data-app-page="bookmarks"]');
		return route && getComputedStyle(route).opacity === "1";
	});
	const bookmarkHeaderLayout = await page.evaluate(() => {
		const viewport = document.querySelector(".browser-viewport");
		const library = document.querySelector(".browser-library");
		const header = library?.querySelector(".ui-page-frame-header");
		const heading = document.querySelector("#bookmarks-title");
		const rect = (node) => node ? Object.fromEntries(
			["left", "right", "top", "bottom", "width", "height"].map(key => [key, node.getBoundingClientRect()[key]]),
		) : null;
		return {
			viewport: rect(viewport),
			library: rect(library),
			header: rect(header),
			heading: rect(heading),
			actions: rect(header?.querySelector(".ui-page-frame-actions")),
			search: rect(header?.querySelector(".library-search input")),
			headerDisplay: header ? getComputedStyle(header).display : "",
			internalOverflow: [library, header, header?.querySelector(".ui-page-frame-actions")]
				.map(node => node ? node.scrollWidth - node.clientWidth : null),
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		};
	});
	const layoutMessage = JSON.stringify(bookmarkHeaderLayout);
	assert(bookmarkHeaderLayout.viewport?.width > 560 && bookmarkHeaderLayout.viewport.width <= 760, layoutMessage);
	assert(await page.evaluate(() => innerWidth > 720), "The pane check must not activate the global <=720px header rule.");
	assert.equal(bookmarkHeaderLayout.headerDisplay, "grid");
	for (const name of ["library", "header", "heading", "actions", "search"]) {
		const bounds = bookmarkHeaderLayout[name];
		assert(bounds?.width > 0 && bounds.height > 0, `Missing Saved pages ${name}: ${layoutMessage}`);
		assert(bounds.left >= bookmarkHeaderLayout.viewport.left - 1 && bounds.right <= bookmarkHeaderLayout.viewport.right + 1,
			`Saved pages ${name} must stay within its pane: ${layoutMessage}`);
	}
	assert(bookmarkHeaderLayout.heading.width > 100, `Saved pages heading was squeezed: ${layoutMessage}`);
	assert(bookmarkHeaderLayout.actions.top >= bookmarkHeaderLayout.heading.bottom - 1,
		`Saved pages actions must flow below the heading in a narrow pane: ${layoutMessage}`);
	assert(bookmarkHeaderLayout.overflow <= 1, layoutMessage);
	assert(bookmarkHeaderLayout.internalOverflow.every(overflow => overflow !== null && overflow <= 1),
		`Saved pages must not hide overflow inside its own containers: ${layoutMessage}`);
	const bookmarkEvidence = resolve(".tmp/desktop-browser");
	mkdirSync(bookmarkEvidence, { recursive: true });
	await page.screenshot({ path: join(bookmarkEvidence, `${packagedExecutable ? "packaged" : "source"}-saved-pages.png`) });
	process.stdout.write(`Saved pages keyboard entry and narrow layout passed: ${layoutMessage}\n`);
	const savedBookmarkRow = page.locator(`.bookmark-library-list > li`).first();
	await savedBookmarkRow.getByRole("button", { name: "Edit", exact: true }).click();
	await savedBookmarkRow.locator(".bookmark-library-edit").waitFor();
	assert.equal(
		await savedBookmarkRow.locator('.bookmark-library-edit select').nth(0).inputValue(),
		"icon",
	);
	await savedBookmarkRow.getByRole("button", { name: "Remove", exact: true }).click();
	await page.waitForFunction(
		() => document.querySelectorAll(".bookmark-library-list > li").length === 0,
	);
	const folderRow = page.locator(".bookmark-library-folders > ul > li").first();
	await folderRow.getByRole("button", { name: "Delete", exact: true }).click();
	await folderRow.getByText("Move pages to bar?", { exact: true }).waitFor();
	await folderRow.getByRole("button", { name: "Delete", exact: true }).click();
	await page.waitForFunction(
		() => document.querySelectorAll(".bookmark-library-folders > ul > li").length === 0,
	);
	state = await browserState();
	assert.equal(state.bookmarks.length, 0, "Removing the fixture bookmark must persist.");
	assert.equal(state.bookmarkFolders.length, 0, "Removing the fixture folder must persist.");
	const pageOneTabId = state.tabs.find((tab) => tab.url === `${origin}/one`)?.id;
	assert(pageOneTabId);
	await page.evaluate(
		async (tabId) => window.kestrel.request({ type: "browser-select-tab", tabId }),
		pageOneTabId,
	);
	await waitForNativeView(
		(value) => value.views[0]?.url === `${origin}/one`,
		"Browser did not return to Page one after bookmark management",
	);
	if (bookmarksWindowSize[0] !== narrowBookmarksWindowWidth) {
		await application.evaluate(
			({ BrowserWindow }, [width, height]) => {
				const window = BrowserWindow.getAllWindows().find(
					(candidate) =>
						!candidate.isDestroyed() &&
						!candidate.webContents.getURL().includes("petOverlay=1"),
				);
				if (!window) throw new Error("The Kestrel window is unavailable.");
				window.setSize(width, height);
			},
			bookmarksWindowSize,
		);
		await page.waitForFunction(
			(width) => innerWidth === width,
			bookmarksWindowSize[0],
		);
	}
	await application.evaluate(({ BrowserWindow }, minimum) => {
		const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && !candidate.webContents.getURL().includes("petOverlay=1"));
		if (!window) throw new Error("The Kestrel window is unavailable.");
		window.setMinimumSize(...minimum);
	}, bookmarksWindowGeometry.minimum);
	if (bookmarksAgentWasOpen) {
		await agentToggle.click();
		await page.waitForFunction(() => document.querySelector("#browser-agent-toggle")?.getAttribute("aria-expanded") === "true");
	}
	process.stdout.write("Saved pages presentation, edit, remove and folder deletion passed.\n");

	return browserState();
}
