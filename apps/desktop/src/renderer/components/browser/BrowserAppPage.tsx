import { motion, useIsPresent } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

/** Interaction follows route presence, even when an exit is interrupted. */
export function BrowserAppPage({
	children,
	className,
	routeId,
	onActivate,
	reducedMotion,
}: {
	children: ReactNode;
	className: string;
	routeId: string;
	onActivate(node: HTMLDivElement): void;
	reducedMotion: boolean;
}) {
	const present = useIsPresent();
	const routeRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (present && routeRef.current) onActivate(routeRef.current);
	}, [present, onActivate]);
	return (
		<motion.div
			ref={routeRef}
			className={className}
			data-app-page={routeId}
			inert={!present}
			style={{ pointerEvents: present ? "auto" : "none" }}
			initial={reducedMotion ? false : { opacity: 0, y: 3 }}
			animate={{ opacity: 1, y: 0 }}
			exit={reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -3 }}
			transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
		>
			{children}
		</motion.div>
	);
}
