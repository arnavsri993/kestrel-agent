import type { SVGProps } from "react";

const paths: Record<string, string[]> = {
	plus: ["M12 5v14M5 12h14"],
	close: ["M6 6l12 12M18 6L6 18"],
	back: ["M15 5l-7 7 7 7"],
	forward: ["M9 5l7 7-7 7"],
	reload: ["M19 8a7.5 7.5 0 10.3 7.6", "M19 3v5h-5"],
	lock: ["M7 10h10v10H7z", "M9 10V7a3 3 0 016 0v3"],
	context: ["M5 6h14v12H5z", "M8 9h8M8 12h5M16 15h1"],
	browser: ["M4 5h16v14H4z", "M4 9h16", "M7 7h.01M10 7h.01"],
	globe: [
		"M12 2a10 10 0 100 20 10 10 0 000-20z",
		"M2 12h20",
		"M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
	],
	tabActions: [
		"M3 5h18",
		"M3 12h18",
		"M3 19h18",
	],
	verticalTabs: [
		"M4 4h4v16H4z",
		"M12 5h8",
		"M12 12h8",
		"M12 19h8",
	],
	history: [
		"M4 12a8 8 0 108-8 8.2 8.2 0 00-6 2.6L4 9",
		"M4 4v5h5",
		"M12 8v4l3 2",
	],
	downloads: ["M12 3v12", "M7 10l5 5 5-5", "M5 20h14"],
	upload: ["M12 21V9", "M7 14l5-5 5 5", "M5 3h14"],
	tools: ["M14.5 6.5a4 4 0 00-5.3 5.3L4 17v3h3l5.2-5.2a4 4 0 005.3-5.3l-2.1 2.1-2.2-2.2z", "M17 4l3 3"],
	sliders: ["M4 6h16", "M4 12h16", "M4 18h16", "M8 4v4M16 10v4M10 16v4"],
	screenshot: ["M5 5h5M5 5v5M19 5h-5M19 5v5M5 19h5M5 19v-5M19 19h-5M19 19v-5"],
	calculator: ["M5 3h14v18H5z", "M8 7h8", "M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 18h8"],
	print: ["M6 9V4h12v5", "M6 18H4v-6h16v6h-2", "M6 15h12v6H6z", "M17 12h.01"],
	devtools: ["M4 5h16v14H4z", "M8 9l3 3-3 3", "M13 15h3"],
	sleep: ["M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"],
	pragmatic: ["M12 2.5l2.1 7.4 7.4 2.1-7.4 2.1-2.1 7.4-2.1-7.4-7.4-2.1 7.4-2.1z", "M19 3v3M17.5 4.5h3"],
	more: ["M6 12h.01M12 12h.01M18 12h.01"],
	agent: [
		"M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2z",
		"M19 16v5M16.5 18.5h5",
	],
	warning: ["M12 4l9 16H3z", "M12 9v5M12 17h.01"],
	command: [
		"M9 6H7a3 3 0 000 6h10a3 3 0 000-6h-2",
		"M9 18H7a3 3 0 010-6h10a3 3 0 010 6h-2",
		"M9 4v16M15 4v16",
	],
	chevron: ["M9 6l6 6-6 6"],
	today: ["M4 5.5h16M7 3v5M17 3v5M5 8.5h14v11H5z", "M8 12h3M13 12h3M8 16h3"],
	chat: ["M4 5h16v11H9l-5 4z", "M8 9h8M8 13h5"],
	readiness: ["M12 3a9 9 0 109 9", "M12 7v5l3 2", "M16.5 5.5l1.4 1.4L21 3.8"],
	approvals: [
		"M12 3l8 4v5c0 4.8-3.2 7.7-8 9-4.8-1.3-8-4.2-8-9V7z",
		"M8.5 12l2.2 2.2L16 9",
	],
	memory: [
		"M6 5.5C6 4.1 8.7 3 12 3s6 1.1 6 2.5S15.3 8 12 8 6 6.9 6 5.5z",
		"M6 5.5v6C6 12.9 8.7 14 12 14s6-1.1 6-2.5v-6M6 11.5v6C6 18.9 8.7 20 12 20s6-1.1 6-2.5v-6",
	],
	activity: ["M5 18V9M12 18V4M19 18v-6", "M3 21h18"],
	connections: [
		"M9 8a4 4 0 015.7 0l1.3-1.3a4 4 0 015.7 5.7L18 16",
		"M15 16a4 4 0 01-5.7 0L8 14.7A4 4 0 012.3 9L6 5.3",
	],
	settings: [
		"M12 9a3 3 0 100 6 3 3 0 000-6z",
		"M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21h-4v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3v-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 001.9.3 1.7 1.7 0 001-1.5V3h4v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.5 1h.1v4h-.1a1.7 1.7 0 00-1.5 1z",
	],
	search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
	star: [
		"M12 3.6l2.3 4.7 5.2.8-3.8 3.6.9 5.1L12 15.8 7.4 17.8l.9-5.1-3.8-3.6 5.2-.8z",
	],
	pin: ["M12 3v10", "M8 7h8", "M12 13l-3 8", "M12 13l3 8"],
	research: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
	work: ["M5 6h14v13H5z", "M9 6V4h6v2M8 11h8M8 15h5"],
	events: ["M5 4h14v16H5z", "M8 2v4M16 2v4M5 8h14", "M9 13l2 2 4-5"],
	artifacts: ["M4 5h6l2 2h8v12H4z", "M8 12l2-2 3 4 2-2 3 4H7z"],
	extensions: [
		"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414l-1.683 1.683a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 0-.474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 1-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
	],
	arrow: ["M5 12h14", "M14 7l5 5-5 5"],
	expand: ["M8 3H3v5", "M3 3l6 6", "M16 21h5v-5", "M21 21l-6-6"],
	check: ["M5 12l4 4L19 6"],
	pause: ["M8 5v14M16 5v14"],
	voice: ["M5 10v4M9 7v10M13 5v14M17 8v8M21 10v4"],
	welcome: [
		"M12 3v3M12 18v3M3 12h3M18 12h3",
		"M6.6 6.6l2.1 2.1M15.3 15.3l2.1 2.1M17.4 6.6l-2.1 2.1M8.7 15.3l-2.1 2.1",
		"M12 9a3 3 0 100 6 3 3 0 000-6z",
	],
	safety: [
		"M12 3l7 3v5c0 4.5-2.8 7.3-7 9-4.2-1.7-7-4.5-7-9V6z",
		"M9 12l2 2 4-4",
	],
	models: ["M7 17h10a4 4 0 00.7-7.9A6 6 0 006.2 8.5 4.5 4.5 0 007 17z"],
	local: [
		"M8 6h8a2 2 0 012 2v8a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2z",
		"M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M18 9h4M2 15h4M18 15h4",
		"M10 10h4v4h-4z",
	],
	free: ["M12 4a8 8 0 108 8", "M12 8v8M8 12h8", "M18.5 3.5v4M16.5 5.5h4"],
	ready: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M8 12l2.5 2.5L16 9"],
	sparkle: [
		"M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z",
		"M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
	],
	compass: [
		"M12 21a9 9 0 100-18 9 9 0 000 18z",
		"M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z",
	],
	info: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 11v5", "M12 8h.01"],
	"check-circle": [
		"M12 21a9 9 0 100-18 9 9 0 000 18z",
		"M8 12l2.5 2.5L16 9",
	],
	"alert-circle": [
		"M12 21a9 9 0 100-18 9 9 0 000 18z",
		"M12 8v5",
		"M12 16.5h.01",
	],
};

const filledStatusPaths: Record<string, { shell: string; mark: string[] }> = {
	"check-circle-filled": {
		shell: "M12 2a10 10 0 110 20 10 10 0 010-20z",
		mark: ["M7.8 12.2l2.7 2.7 5.8-6"],
	},
	"alert-triangle-filled": {
		shell: "M10.3 3.3a2 2 0 013.4 0l8 14A2 2 0 0120 20H4a2 2 0 01-1.7-3l8-13.7z",
		mark: ["M12 8.3v5.2", "M12 16.8h.01"],
	},
	"x-circle-filled": {
		shell: "M12 2a10 10 0 110 20 10 10 0 010-20z",
		mark: ["M8.5 8.5l7 7", "M15.5 8.5l-7 7"],
	},
	"info-filled": {
		shell: "M12 2a10 10 0 110 20 10 10 0 010-20z",
		mark: ["M12 10.8v5", "M12 7.4h.01"],
	},
};

export function Icon({
	name,
	...props
}: SVGProps<SVGSVGElement> & { name: string }) {
	const filled = filledStatusPaths[name];
	if (filled) {
		return (
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
				{...props}
			>
				<path d={filled.shell} fill="currentColor" stroke="none" />
				{filled.mark.map((path) => (
					<path
						d={path}
						key={path}
						stroke="var(--status-fill)"
						strokeWidth="1.9"
					/>
				))}
			</svg>
		);
	}
	if (name === "loader") {
		return (
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				{...props}
			>
				<circle cx="12" cy="12" r="8" opacity="0.28" />
				<path d="M12 4a8 8 0 014.9 1.7" />
			</svg>
		);
	}
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			{(paths[name] ?? paths.arrow)!.map((path) => (
				<path d={path} key={path} />
			))}
		</svg>
	);
}
