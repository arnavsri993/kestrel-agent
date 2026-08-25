import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";

export interface DefaultBrowserPromptProps {
	isOpen: boolean;
	onClose: () => void;
	onSetDefault?: () => void;
}

export function DefaultBrowserPrompt({
	isOpen,
	onClose,
	onSetDefault,
}: DefaultBrowserPromptProps) {
	const reduced = useReducedMotion() ?? false;
	const [settingDefault, setSettingDefault] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const primaryButtonRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => {
				primaryButtonRef.current?.focus();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape" && isOpen && !settingDefault) {
				event.preventDefault();
				onClose();
			}
		},
		[isOpen, settingDefault, onClose],
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
				onClose();
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
				<div
					key="default-browser-prompt"
					className="default-browser-modal-backdrop"
					role="presentation"
					onClick={(e) => {
						if (e.target === e.currentTarget && !settingDefault) {
							onClose();
						}
					}}
				>
					<motion.div
						className="default-browser-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="default-browser-prompt-title"
						aria-describedby="default-browser-prompt-description"
						initial={
							reduced ? { opacity: 1 } : { opacity: 0, scale: 0.94, y: 12 }
						}
						animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
						exit={
							reduced ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 8 }
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
							onClick={onClose}
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
								onClick={onClose}
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
				</div>
			)}
		</AnimatePresence>
	);
}
