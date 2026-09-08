import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

export interface DefaultBrowserPromptProps {
	isOpen: boolean;
	onClose: () => void;
	onSetDefault?: () => void;
}

const FOCUSABLE_SELECTOR =
	"button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function focusDialogEdge(
	event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
	activeElement: Element | null,
	focusable: readonly HTMLElement[],
): void {
	if (event.key !== "Tab" || focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable.at(-1);
	if (event.shiftKey && activeElement === first) {
		event.preventDefault();
		last?.focus();
	} else if (!event.shiftKey && activeElement === last) {
		event.preventDefault();
		first?.focus();
	}
}

export function restoreDialogOpener(opener: HTMLElement | null): void {
	if (opener?.isConnected) opener.focus();
}

export function DefaultBrowserPrompt({
	isOpen,
	onClose,
	onSetDefault,
}: DefaultBrowserPromptProps) {
	const reduced = useReducedMotion() ?? false;
	const [settingDefault, setSettingDefault] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);

	const restoreFocus = useCallback(() => {
		restoreDialogOpener(returnFocusRef.current);
		returnFocusRef.current = null;
	}, []);

	const finishClose = useCallback(() => {
		restoreFocus();
		onClose();
	}, [onClose, restoreFocus]);

	const close = useCallback(() => {
		if (settingDefault) return;
		finishClose();
	}, [finishClose, settingDefault]);

	useEffect(() => {
		if (!isOpen) return;
		if (document.activeElement instanceof HTMLElement) {
			returnFocusRef.current = document.activeElement;
		}
		const frame = window.requestAnimationFrame(() => {
			primaryButtonRef.current?.focus();
		});
		return () => {
			window.cancelAnimationFrame(frame);
			restoreFocus();
		};
	}, [isOpen, restoreFocus]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape" && isOpen && !settingDefault) {
				if (event.defaultPrevented) return;
				event.preventDefault();
				close();
				return;
			}
			if (!isOpen || !dialogRef.current) return;
			focusDialogEdge(
				event,
				document.activeElement,
				Array.from(
					dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
				),
			);
		},
		[close, isOpen, settingDefault],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	const handleSetAsDefault = async () => {
		setSettingDefault(true);
		setError(null);
		try {
			const response = await window.kestrel.request({
				type: "set-default-browser",
			});
			if (
				response.ok &&
				"success" in response &&
				response.success &&
				(!("canSetAsDefault" in response) || response.canSetAsDefault)
			) {
				onSetDefault?.();
				finishClose();
			} else if (
				response.ok &&
				"canSetAsDefault" in response &&
				!response.canSetAsDefault
			) {
				setError("Install Kestrel before choosing it as the default browser.");
			} else {
				setError("Could not set Kestrel as default browser.");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to set default browser.",
			);
		} finally {
			setSettingDefault(false);
		}
	};

	return (
		<AnimatePresence initial={false}>
			{isOpen && (
				<motion.div
					key="default-browser-prompt"
					className="default-browser-modal-backdrop"
					role="presentation"
					initial={reduced ? false : { opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={
						reduced
							? { opacity: 1, pointerEvents: "none" }
							: { opacity: 0, pointerEvents: "none" }
					}
					transition={{ duration: reduced ? 0 : 0.14 }}
					onClick={(e) => {
						if (e.target === e.currentTarget && !settingDefault) {
							close();
						}
					}}
				>
					<motion.div
						ref={dialogRef}
						className="default-browser-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="default-browser-prompt-title"
						aria-describedby="default-browser-prompt-description"
						initial={reduced ? false : { opacity: 0, scale: 0.96, y: 8 }}
						animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
						exit={
							reduced ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: 6 }
						}
						transition={{
							duration: reduced ? 0 : 0.18,
							ease: [0.22, 1, 0.36, 1],
						}}
					>
						<button
							type="button"
							className="default-browser-close-button"
							aria-label="Dismiss"
							onClick={close}
							disabled={settingDefault}
						>
							<Icon name="close" />
						</button>

						<div className="default-browser-icon-badge">
							<span className="default-browser-brand-mark">
								<BrandMark />
							</span>
							<span className="default-browser-sub-icon">
								<Icon name="browser" />
							</span>
						</div>

						<div className="default-browser-content">
							<h2 id="default-browser-prompt-title">
								Set Kestrel as your default browser?
							</h2>
							<p id="default-browser-prompt-description">
								Open links from other apps directly in Kestrel.
							</p>
							{error && <p className="default-browser-error">{error}</p>}
						</div>

						<div className="default-browser-actions">
							<button
								type="button"
								className="button quiet"
								onClick={close}
								disabled={settingDefault}
							>
								Not Now
							</button>
							<button
								ref={primaryButtonRef}
								type="button"
								className="button primary default-browser-primary-btn"
								onClick={() => void handleSetAsDefault()}
								disabled={settingDefault}
							>
								{settingDefault ? "Setting default…" : "Set as default browser"}
								<Icon name="arrow" />
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
