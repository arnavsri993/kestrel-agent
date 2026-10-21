const APP_STORE_PROTOCOLS = new Set([
	"itms-apps:",
	"itms-appss:",
	"macappstore:",
]);
const APP_STORE_HOSTS = new Set([
	"apps.apple.com",
	"itunes.apple.com",
	"geo.itunes.apple.com",
]);
const ZOOM_JOIN_PROTOCOLS = new Set(["zoommtg:", "zoomus:"]);
const ZOOM_MEETING_NUMBER = /^\d{9,11}$/;
const TEAMS_HOSTS = new Set([
	"teams.microsoft.com",
	"teams.live.com",
	"teams.cloud.microsoft",
]);
const INVALID_EXTERNAL_URL_CHARACTERS = /[\\\u0000-\u0020\u007f]/;

export type ExternalAppTarget = {
	appName: "App Store" | "Cursor" | "Microsoft Teams" | "Zoom";
	appUrl: string;
	handlerUrl: string;
	webFallback: boolean;
};

/** Allow only Apple App Store product links to cross into macOS. */
export function safeAppStoreUrl(value: string): string | undefined {
	if (
		!value ||
		value.length > 8_192 ||
		INVALID_EXTERNAL_URL_CHARACTERS.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		if (
			!APP_STORE_PROTOCOLS.has(url.protocol) ||
			!APP_STORE_HOSTS.has(url.hostname.toLowerCase()) ||
			url.port ||
			url.username ||
			url.password ||
			url.hash
		)
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Allow only a Zoom meeting join, never a host, start, or command link. */
export function safeZoomJoinUrl(value: string): string | undefined {
	if (
		!value ||
		value.length > 8_192 ||
		INVALID_EXTERNAL_URL_CHARACTERS.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		const meetingNumbers = url.searchParams.getAll("confno");
		const actions = url.searchParams.getAll("action");
		const passwords = url.searchParams.getAll("pwd");
		if (
			!ZOOM_JOIN_PROTOCOLS.has(url.protocol) ||
			url.hostname.toLowerCase() !== "zoom.us" ||
			url.pathname !== "/join" ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			meetingNumbers.length !== 1 ||
			!ZOOM_MEETING_NUMBER.test(meetingNumbers[0] ?? "") ||
			actions.length > 1 ||
			(actions.length === 1 && actions[0] !== "join") ||
			passwords.length > 1
		)
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Teams launchers use bounded /l/... routes and numeric /meet/<id> links. */
export function safeTeamsUrl(value: string): string | undefined {
	if (
		!value ||
		value.length > 8_192 ||
		INVALID_EXTERNAL_URL_CHARACTERS.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		const supportedPath =
			/^\/l\/(?:meetup-join|team|channel|chat|message)\/[^/]+(?:\/[^/]+)*\/?$/.test(
				url.pathname,
			) || /^\/meet\/\d+\/?$/.test(url.pathname);
		if (
			url.protocol !== "msteams:" ||
			!["", ...TEAMS_HOSTS].includes(url.hostname.toLowerCase()) ||
			url.username ||
			url.password ||
			url.port ||
			url.hash ||
			!supportedPath
		)
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Convert only current numeric Teams HTTPS invitations to the native scheme. */
export function safeTeamsMeetingAppUrl(value: string): string | undefined {
	if (
		!value ||
		value.length > 8_192 ||
		INVALID_EXTERNAL_URL_CHARACTERS.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			!TEAMS_HOSTS.has(url.hostname.toLowerCase()) ||
			!/^\/meet\/\d+\/?$/.test(url.pathname) ||
			url.username ||
			url.password ||
			url.port ||
			url.hash
		)
			return undefined;
		return safeTeamsUrl(`msteams://${url.host}${url.pathname}${url.search}`);
	} catch {
		return undefined;
	}
}

/** Allow only Cursor authentication callbacks, never file or command links. */
export function safeCursorAuthUrl(value: string): string | undefined {
	if (
		!value ||
		value.length > 8_192 ||
		INVALID_EXTERNAL_URL_CHARACTERS.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "cursor:" ||
			url.username ||
			url.password ||
			url.port ||
			url.hash
		)
			return undefined;
		const host = url.hostname.toLowerCase();
		const login =
			host === "cursorauth" && (url.pathname === "" || url.pathname === "/");
		const oauth =
			host === "anysphere.cursor-mcp" &&
			["/oauth/callback", "/oauth/return"].includes(url.pathname);
		return login || oauth ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

export function externalAppTarget(value: string): ExternalAppTarget | undefined {
	const appStoreUrl = safeAppStoreUrl(value);
	if (appStoreUrl) {
		const protocol = new URL(appStoreUrl).protocol;
		return {
			appName: "App Store",
			appUrl: appStoreUrl,
			handlerUrl: `${protocol}//`,
			webFallback: false,
		};
	}
	const zoomUrl = safeZoomJoinUrl(value);
	if (zoomUrl) {
		const protocol = new URL(zoomUrl).protocol;
		return {
			appName: "Zoom",
			appUrl: zoomUrl,
			handlerUrl: `${protocol}//`,
			webFallback: false,
		};
	}
	const teamsUrl = safeTeamsUrl(value);
	if (teamsUrl)
		return {
			appName: "Microsoft Teams",
			appUrl: teamsUrl,
			handlerUrl: "msteams://",
			webFallback: false,
		};
	const cursorUrl = safeCursorAuthUrl(value);
	if (cursorUrl)
		return {
			appName: "Cursor",
			appUrl: cursorUrl,
			handlerUrl: "cursor://",
			webFallback: false,
		};
	const teamsMeetingUrl = safeTeamsMeetingAppUrl(value);
	if (teamsMeetingUrl)
		return {
			appName: "Microsoft Teams",
			appUrl: teamsMeetingUrl,
			handlerUrl: "msteams://",
			webFallback: true,
		};
	return undefined;
}

/** Only the Teams meeting launcher may carry native input across a commit. */
export function isTeamsMeetingLauncher(value: string): boolean {
	if (!value || value.length > 8_192 || INVALID_EXTERNAL_URL_CHARACTERS.test(value))
		return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && TEAMS_HOSTS.has(url.hostname.toLowerCase()) &&
			!url.username && !url.password && !url.port && !url.hash &&
			/^\/l\/meetup-join\/[^/]+\/[^/]+\/?$/.test(url.pathname);
	} catch { return false; }
}
