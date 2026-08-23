import type { AgentState } from "@kestrel/shared-types";

export type MacAgentVisualState =
	| "idle"
	| "thinking"
	| "acting"
	| "waiting"
	| "completed";

export function visualStateForAgentState(state: AgentState): MacAgentVisualState {
	if (state === "observing" || state === "updating") return "thinking";
	if (state === "working") return "acting";
	if (state === "waiting_approval") return "waiting";
	return "idle";
}

function stateColor(state: MacAgentVisualState): string {
	switch (state) {
		case "acting":
			return "#d7ff52";
		case "thinking":
			return "#f5c96a";
		case "waiting":
			return "#f29b72";
		case "completed":
			return "#b9e67c";
		default:
			return "#f4f7f1";
	}
}

function trianglePath(cx: number, cy: number, size: number): string {
	const half = size / 2;
	const top = cy - size * 0.58;
	const bottom = cy + size * 0.42;
	return `M ${cx} ${top} L ${cx + half} ${bottom} L ${cx - half} ${bottom} Z`;
}

export function dockIconSvg(state: MacAgentVisualState, frame = 0): string {
	const color = stateColor(state);
	const drift = state === "acting" ? frame * 13 : state === "thinking" ? frame * 4 : 0;
	const scale = state === "thinking" ? (frame % 2 === 0 ? 0.96 : 1.04) : 1;
	const transform = `translate(512 512) scale(${scale}) translate(-512 -512)`;
	const third = trianglePath(512 + drift, 502, 330);
	const inner = trianglePath(512 + drift, 520, 120);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="220" fill="#101713"/><g transform="${transform}"><path d="${third}" fill="${color}"/><path d="${inner}" fill="#101713" opacity="${state === "idle" ? "0.82" : "0.62"}"/>${state === "acting" ? `<path d="M 252 784 L 772 784" fill="none" stroke="${color}" stroke-width="28" stroke-linecap="round" opacity=".72"/>` : ""}${state === "waiting" ? `<circle cx="512" cy="520" r="30" fill="${color}"/>` : ""}${state === "completed" ? `<path d="M 420 520 L 490 590 L 620 442" fill="none" stroke="${color}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>` : ""}</g></svg>`;
}

export function menuBarIconSvg(state: MacAgentVisualState): string {
	const color = state === "idle" ? "black" : stateColor(state);
	const fill = state === "idle" ? "none" : color;
	const inner = state === "waiting" ? `<circle cx="9" cy="9" r="2" fill="${color}"/>` : "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M9 2.1 16 15.4c.25.48-.1 1.05-.64 1.05H2.64c-.54 0-.89-.57-.64-1.05L9 2.1Z" fill="${fill}" stroke="${color}" stroke-width="1.45" stroke-linejoin="round"/>${inner}</svg>`;
}

export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
