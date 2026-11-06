import { motion, useIsPresent } from "motion/react";
import { forwardRef, type ReactNode } from "react";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

interface BrowserAppPageProps {
	pageId: string;
	className: string;
	reduced: boolean;
	children: ReactNode;
}

/** Input belongs to the currently present route, independently of its animation. */
export const BrowserAppPage = forwardRef<HTMLDivElement, BrowserAppPageProps>(
	function BrowserAppPage({ pageId, className, reduced, children }, ref) {
		const isPresent = useIsPresent();
		return (
			<motion.div
				ref={ref}
				className={className}
				data-app-page={pageId}
				style={{ pointerEvents: isPresent ? "auto" : "none" }}
				inert={!isPresent}
				aria-hidden={isPresent ? undefined : true}
				initial={reduced ? false : { opacity: 0, y: 3 }}
				animate={{ opacity: 1, y: 0 }}
				exit={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: -3 }}
				transition={reduced ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			>
				{children}
			</motion.div>
		);
	},
);
