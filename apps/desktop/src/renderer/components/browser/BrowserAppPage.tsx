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
	hidden = false,
}: {
	children: ReactNode;
	className: string;
	routeId: string;
	onActivate(node: HTMLDivElement): void;
	reducedMotion: boolean;
	hidden?: boolean;
}) {
	const present = useIsPresent();
	const routeRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (present && !hidden && routeRef.current) onActivate(routeRef.current);
	}, [present, hidden, onActivate]);
	return (
		<motion.div
			ref={routeRef}
			className={className}
			data-app-page={routeId}
			hidden={hidden}
			inert={!present || hidden}
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
