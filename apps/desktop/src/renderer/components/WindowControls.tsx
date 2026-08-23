import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

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
	close: "M2.25 2.25 7.75 7.75M7.75 2.25 2.25 7.75",
	minimize: "M2.1 5h5.8",
	zoom:
		"M3.05 6.95 6.95 3.05M4.5 3.05h2.45V5.5M5.5 6.95H3.05V4.5",
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
				button.classList.remove("window-control-active");
			});
	}, []);

	useEffect(() => {
		if (!isMacOS()) return;
		const handleFocus = () => setWindowActive(true);
		const handleBlur = () => {
			setWindowActive(false);
			resetProximity();
		};

		function updateProximity(event: PointerEvent) {
			const node = controlsRef.current;
			if (!node) return;
			const buttons = Array.from(
				node.querySelectorAll<HTMLElement>(".window-control"),
			);
			const measurements = buttons.map((button) => {
				const bounds = button.getBoundingClientRect();
				const dx = event.clientX - (bounds.left + bounds.width / 2);
				const dy = event.clientY - (bounds.top + bounds.height / 2);
				return {
					button,
					bounds,
					dx,
					distance: Math.hypot(dx, dy),
				};
			});
			let nearestIndex = -1;
			let nearestDistance = Number.POSITIVE_INFINITY;
			measurements.forEach(({ distance }, index) => {
				if (distance < nearestDistance) {
					nearestDistance = distance;
					nearestIndex = index;
				}
			});
			const activeIndex = nearestDistance <= 28 ? nearestIndex : -1;

			measurements.forEach(({ button, bounds, distance, dx }, index) => {
				const raw = Math.max(0, Math.min(1, 1 - distance / 58));
				const eased = raw * raw * (3 - 2 * raw);
				const isInside =
					event.clientX >= bounds.left &&
					event.clientX <= bounds.right &&
					event.clientY >= bounds.top &&
					event.clientY <= bounds.bottom;
				const tilt = isInside
					? 0
					: Math.max(-8, Math.min(8, (-dx / 28) * eased * 8));
				button.classList.toggle(
					"window-control-active",
					index === activeIndex,
				);
				button.style.setProperty(
					"--window-control-icon-opacity",
					(eased * 0.86).toFixed(3),
				);
				button.style.setProperty(
					"--window-control-icon-scale",
					(1 + eased * 0.08).toFixed(3),
				);
				button.style.setProperty(
					"--window-control-scale",
					(1 + eased * 0.07).toFixed(3),
				);
				button.style.setProperty(
					"--window-control-lift",
					`${(-eased * 1.8).toFixed(2)}px`,
				);
				button.style.setProperty(
					"--window-control-tilt",
					`${tilt.toFixed(2)}deg`,
				);
			});
		}

		window.addEventListener("pointermove", updateProximity, { passive: true });
		window.addEventListener("focus", handleFocus);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("pointermove", updateProximity);
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
						</svg>
					</span>
					<WindowControlGlyph glyph={control.glyph} />
				</button>
			))}
		</div>
	);
}
