import {
	useCallback,
	useEffect,
	useRef,
} from "react";

const controls = [
	{
		type: "window-close" as const,
		className: "window-control-close",
		glyph: "close",
		label: "Close window",
		title: "Close window",
	},
	{
		type: "window-minimize" as const,
		className: "window-control-minimize",
		glyph: "minimize",
		label: "Minimize window",
		title: "Minimize window",
	},
	{
		type: "window-toggle-zoom" as const,
		className: "window-control-zoom",
		glyph: "zoom",
		label: "Zoom window",
		title: "Zoom window",
	},
] as const;

function isMacOS(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
}

export function WindowControls() {
	const controlsRef = useRef<HTMLDivElement | null>(null);
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
				button.classList.remove("window-control-near");
			});
	}, []);

	useEffect(() => {
		if (!isMacOS()) return;

		function updateProximity(event: PointerEvent) {
			const node = controlsRef.current;
			if (!node) return;
			node.querySelectorAll<HTMLElement>(".window-control").forEach((button) => {
				const bounds = button.getBoundingClientRect();
				const distance = Math.hypot(
					event.clientX - (bounds.left + bounds.width / 2),
					event.clientY - (bounds.top + bounds.height / 2),
				);
				const raw = Math.max(0, Math.min(1, 1 - distance / 56));
				const eased = raw * raw * (3 - 2 * raw);
				button.classList.toggle("window-control-near", raw > 0.55);
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
			});
		}

		window.addEventListener("pointermove", updateProximity, { passive: true });
		window.addEventListener("blur", resetProximity);
		return () => {
			window.removeEventListener("pointermove", updateProximity);
			window.removeEventListener("blur", resetProximity);
		};
	}, [resetProximity]);

	if (!isMacOS()) return null;

	return (
		<div
			ref={controlsRef}
			className="window-controls"
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
					<span
						className={`window-control-glyph window-control-glyph-${control.glyph}`}
						aria-hidden="true"
					/>
				</button>
			))}
		</div>
	);
}
