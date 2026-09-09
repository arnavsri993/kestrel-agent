import { useEffect } from "react";

// Deliberately bounded to everyday chrome, never approval/destructive controls.
const actions = [
	".browser-navigation button",
	".browser-new-tab",
	".browser-toolbar-actions > button",
	".kestrel-widget-customize",
	".kestrel-widget-add-menu > button",
	".kestrel-widget-size-menu > button",
	".browser-bookmark",
	".kestrel-sidebar-header-actions button",
	".kestrel-sidebar-new-task",
	".kestrel-home-send",
].join(",");

/** Pointer feedback decorates the icon; native button geometry and clicks stay intact. */
export function ActionMotion() {
	useEffect(() => {
		const preference = matchMedia("(prefers-reduced-motion: reduce)");
		let active: HTMLButtonElement | null = null;
		let icon: SVGElement | null = null;
		let frame = 0;
		let x = 0;
		let y = 0;
		const reset = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			icon?.style.removeProperty("--action-x");
			icon?.style.removeProperty("--action-y");
			icon?.style.removeProperty("--action-tilt");
			active = null;
			icon = null;
		};
		const move = (event: PointerEvent) => {
			if (preference.matches || event.pointerType !== "mouse" || event.buttons) {
				reset();
				return;
			}
			const button = event.target instanceof Element
				? event.target.closest<HTMLButtonElement>(actions) : null;
			if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
				reset();
				return;
			}
			if (active !== button) {
				reset();
				active = button;
				icon = button.querySelector<SVGElement>(":scope > svg");
			}
			x = event.clientX;
			y = event.clientY;
			if (frame || !icon) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (!active?.isConnected || active.disabled || !icon) return reset();
				// Read the stationary button once per frame, before writing only its icon.
				const bounds = active.getBoundingClientRect();
				const dx = Math.max(-1, Math.min(1, (x - bounds.left) / Math.max(1, bounds.width) * 2 - 1));
				const dy = Math.max(-1, Math.min(1, (y - bounds.top) / Math.max(1, bounds.height) * 2 - 1));
				icon.style.setProperty("--action-x", `${dx * 2}px`);
				icon.style.setProperty("--action-y", `${dy * 2}px`);
				icon.style.setProperty("--action-tilt", `${dx * 6}deg`);
			});
		};
		const leave = (event: PointerEvent) => {
			if (!(event.relatedTarget instanceof Node) || !active?.contains(event.relatedTarget)) reset();
		};
		document.addEventListener("pointermove", move, { passive: true });
		document.addEventListener("pointerout", leave, { passive: true });
		document.addEventListener("pointercancel", reset);
		document.addEventListener("pointerdown", reset, { passive: true });
		document.addEventListener("visibilitychange", reset);
		window.addEventListener("blur", reset);
		window.addEventListener("resize", reset);
		document.addEventListener("scroll", reset, true);
		preference.addEventListener("change", reset);
		return () => {
			reset();
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerout", leave);
			document.removeEventListener("pointercancel", reset);
			document.removeEventListener("pointerdown", reset);
			document.removeEventListener("visibilitychange", reset);
			window.removeEventListener("blur", reset);
			window.removeEventListener("resize", reset);
			document.removeEventListener("scroll", reset, true);
			preference.removeEventListener("change", reset);
		};
	}, []);
	return null;
}
