import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	activeWindowControlIndex,
	calculateWindowControlMotion,
	centeredWindowControlsTop,
	type WindowControlBounds,
	type WindowControlPoint,
} from "./window-controls-motion";

const controls = [
	{
		type: "window-close" as const,
		className: "window-control-close",
		glyph: "close" as const,
		label: "Close window",
		title: "Close window",
	},
	{
		type: "window-minimize" as const,
		className: "window-control-minimize",
		glyph: "minimize" as const,
		label: "Minimize window",
		title: "Minimize window",
	},
	{
		type: "window-toggle-zoom" as const,
		className: "window-control-zoom",
		glyph: "zoom" as const,
		label: "Zoom window",
		title: "Zoom window",
	},
] as const;

type WindowControlGlyph = (typeof controls)[number]["glyph"];

const glyphPaths: Record<WindowControlGlyph, string> = {
	close: "M1.7 1.7 8.3 8.3M8.3 1.7 1.7 8.3",
	minimize: "M1.55 5h6.9",
	zoom:
		"M2.35 7.65 7.65 2.35M4.15 2.35h3.5v3.5M5.85 7.65h-3.5v-3.5",
};

function WindowControlGlyph({ glyph }: { glyph: WindowControlGlyph }) {
	return (
		<svg
			className={`window-control-glyph window-control-glyph-${glyph}`}
			viewBox="0 0 10 10"
			aria-hidden="true"
			focusable="false"
		>
			<path d={glyphPaths[glyph]} />
		</svg>
	);
}

function isMacOS(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
}

export function WindowControls() {
	const controlsRef = useRef<HTMLDivElement | null>(null);
	const [windowActive, setWindowActive] = useState(() =>
		typeof document === "undefined" ? true : document.hasFocus(),
	);
	const activate = useCallback((type: (typeof controls)[number]["type"]) => {
		void window.kestrel.request({ type }).catch(() => undefined);
	}, []);
	const resetProximity = useCallback(() => {
		controlsRef.current
			?.querySelectorAll<HTMLElement>(".window-control")
			.forEach((button) => {
				button.style.setProperty("--window-control-icon-opacity", "0");
				button.style.setProperty("--window-control-icon-scale", "1");
				button.style.setProperty("--window-control-lift", "0px");
				button.style.setProperty("--window-control-scale", "1");
				button.style.setProperty("--window-control-tilt", "0deg");
				button.style.setProperty("--window-control-triangle-x", "0px");
				button.style.setProperty("--window-control-triangle-y", "0px");
				button.style.setProperty("--window-control-fill-shade", "0");
				button.classList.remove("window-control-active");
			});
	}, []);

	useLayoutEffect(() => {
		const controlsNode = controlsRef.current;
		if (controlsNode === null) return;
		const controlsElement = controlsNode as HTMLDivElement;

		const barSelectors = [
			".onboarding-bar",
			".browser-workspace-vertical .browser-toolbar",
			".browser-tab-row-horizontal",
			".secondary-surface-bar",
			".drag-region",
		];
		let animationFrame = 0;

		function alignToTopBar() {
			const bar = barSelectors
				.map((selector) => document.querySelector<HTMLElement>(selector))
				.find(
					(candidate) =>
						candidate && candidate.getBoundingClientRect().height > 0,
				);
			const controlHeight =
				controlsElement.getBoundingClientRect().height || 28;
			const barBounds = bar?.getBoundingClientRect();
			const top = centeredWindowControlsTop(
				barBounds?.top ?? 0,
				barBounds?.height ?? 40,
				controlHeight,
			);
			controlsElement.style.setProperty("--window-controls-top", `${top}px`);
		}

		function scheduleAlignment() {
			if (animationFrame) return;
			animationFrame = window.requestAnimationFrame(() => {
				animationFrame = 0;
				alignToTopBar();
			});
		}

		alignToTopBar();
		window.addEventListener("resize", scheduleAlignment, { passive: true });
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(scheduleAlignment);
		resizeObserver?.observe(controlsElement);
		const root = document.getElementById("root");
		let mutationObserver: MutationObserver | null = null;
		if (typeof MutationObserver !== "undefined" && root) {
			mutationObserver = new MutationObserver((records) => {
				if (
					records.some(
						({ target }) => !controlsElement.contains(target),
					)
				)
					scheduleAlignment();
			});
			mutationObserver.observe(root, {
				attributes: true,
				attributeFilter: ["class"],
				subtree: true,
				childList: true,
			});
		}

		return () => {
			if (animationFrame) window.cancelAnimationFrame(animationFrame);
			resizeObserver?.disconnect();
			mutationObserver?.disconnect();
			window.removeEventListener("resize", scheduleAlignment);
		};
	}, []);

	useEffect(() => {
		if (!isMacOS()) return;
		const handleFocus = () => setWindowActive(true);
		let animationFrame = 0;
		let geometryDirty = true;
		let proximityActive = false;
		let latestPointer: WindowControlPoint | null = null;
		let measurements: Array<{
			button: HTMLElement;
			bounds: WindowControlBounds;
		}> = [];

		function measureControls() {
			const node = controlsRef.current;
			if (!node) return [];
			const nodeBounds = node.getBoundingClientRect();
			return Array.from(
				node.querySelectorAll<HTMLElement>(".window-control"),
			).map((button) => {
				// Use the untransformed layout box. Measuring the transformed button
				// makes the pointer target move underneath the cursor as proximity
				// scaling and lift are applied, which causes visible jitter.
				const bounds: WindowControlBounds = {
					left: nodeBounds.left + button.offsetLeft,
					top: nodeBounds.top + button.offsetTop,
					width: button.offsetWidth,
					height: button.offsetHeight,
					right: nodeBounds.left + button.offsetLeft + button.offsetWidth,
					bottom: nodeBounds.top + button.offsetTop + button.offsetHeight,
				};
				return { button, bounds };
			});
		}

		function renderProximity() {
			animationFrame = 0;
			if (!latestPointer) return;
			if (geometryDirty) {
				measurements = measureControls();
				geometryDirty = false;
			}
			const motions = measurements.map(({ bounds }) =>
				calculateWindowControlMotion(latestPointer!, bounds),
			);
			if (!motions.some((motion) => motion.iconOpacity > 0)) {
				if (proximityActive) resetProximity();
				proximityActive = false;
				return;
			}
			proximityActive = true;
			const activeIndex = activeWindowControlIndex(motions);

			measurements.forEach(({ button }, index) => {
				const motion = motions[index]!;
				button.classList.toggle(
					"window-control-active",
					index === activeIndex,
				);
				button.style.setProperty(
					"--window-control-icon-opacity",
					motion.iconOpacity.toFixed(3),
				);
				button.style.setProperty(
					"--window-control-icon-scale",
					motion.iconScale.toFixed(3),
				);
				button.style.setProperty(
					"--window-control-scale",
					motion.controlScale.toFixed(3),
				);
				button.style.setProperty(
					"--window-control-lift",
					`${motion.lift.toFixed(2)}px`,
				);
				button.style.setProperty(
					"--window-control-tilt",
					`${motion.tilt.toFixed(2)}deg`,
				);
				button.style.setProperty(
					"--window-control-triangle-x",
					`${motion.triangleX.toFixed(2)}px`,
				);
				button.style.setProperty(
					"--window-control-triangle-y",
					`${motion.triangleY.toFixed(2)}px`,
				);
				button.style.setProperty(
					"--window-control-fill-shade",
					motion.fillShade.toFixed(3),
				);
			});
		}

		function scheduleProximity() {
			if (!animationFrame)
				animationFrame = window.requestAnimationFrame(renderProximity);
		}

		function updateProximity(event: PointerEvent) {
			latestPointer = { x: event.clientX, y: event.clientY };
			scheduleProximity();
		}

		function invalidateGeometry() {
			geometryDirty = true;
			if (latestPointer) scheduleProximity();
		}

		function clearProximity() {
			latestPointer = null;
			if (animationFrame) window.cancelAnimationFrame(animationFrame);
			animationFrame = 0;
			proximityActive = false;
			resetProximity();
		}

		const handleBlur = () => {
			setWindowActive(false);
			clearProximity();
		};

		function resetWhenPointerLeavesWindow(event: PointerEvent) {
			if (event.relatedTarget === null) clearProximity();
		}

		const resizeObserver = new ResizeObserver(invalidateGeometry);
		const node = controlsRef.current;
		if (node) {
			resizeObserver.observe(node);
			node
				.querySelectorAll<HTMLElement>(".window-control")
				.forEach((button) => resizeObserver.observe(button));
		}

		window.addEventListener("pointermove", updateProximity, { passive: true });
		window.addEventListener("pointerout", resetWhenPointerLeavesWindow);
		window.addEventListener("pointercancel", clearProximity);
		window.addEventListener("resize", invalidateGeometry, { passive: true });
		window.addEventListener("focus", handleFocus);
		window.addEventListener("blur", handleBlur);
		return () => {
			if (animationFrame) window.cancelAnimationFrame(animationFrame);
			resizeObserver.disconnect();
			window.removeEventListener("pointermove", updateProximity);
			window.removeEventListener("pointerout", resetWhenPointerLeavesWindow);
			window.removeEventListener("pointercancel", clearProximity);
			window.removeEventListener("resize", invalidateGeometry);
			window.removeEventListener("focus", handleFocus);
			window.removeEventListener("blur", handleBlur);
		};
	}, [resetProximity]);

	if (!isMacOS()) return null;

	return (
		<div
			ref={controlsRef}
			className={`window-controls ${windowActive ? "" : "window-controls-inactive"}`}
			role="group"
			aria-label="Window controls"
		>
			{controls.map((control) => (
				<button
					className={`window-control ${control.className}`}
					type="button"
					key={control.type}
					aria-label={control.label}
					title={control.title}
					onClick={() => activate(control.type)}
				>
					<span className="window-control-triangle" aria-hidden="true">
						<svg viewBox="0 0 24 22" focusable="false">
							<path
								className="window-control-fill"
								transform="translate(0 -0.8)"
								d="M10.55 3.83c.62-1.09 2.28-1.09 2.9 0l7.72 13.55c.66 1.15-.18 2.57-1.51 2.57H4.34c-1.33 0-2.17-1.42-1.51-2.57l7.72-13.55Z"
							/>
							<path
								className="window-control-shade"
								transform="translate(0 -0.8)"
								d="M10.55 3.83c.62-1.09 2.28-1.09 2.9 0l7.72 13.55c.66 1.15-.18 2.57-1.51 2.57H4.34c-1.33 0-2.17-1.42-1.51-2.57l7.72-13.55Z"
							/>
						</svg>
					</span>
					<WindowControlGlyph glyph={control.glyph} />
				</button>
			))}
		</div>
	);
}
