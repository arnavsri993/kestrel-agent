import type { Approval } from "@kestrel/shared-types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export function ApprovalCard({
	approval,
	onApprove,
	onReject,
	onEdit,
}: {
	approval: Approval;
	onApprove(): Promise<void>;
	onReject(): Promise<void>;
	onEdit(body: string): Promise<void>;
}) {
	const [busy, setBusy] = useState<"approve" | "reject" | "save" | null>(null);
	const [editing, setEditing] = useState(false);
	const [body, setBody] = useState(approval.proposedEmail.body);
	const [actionError, setActionError] = useState("");
	const [focusRequest, setFocusRequest] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const focusTargetRef = useRef<HTMLElement | "edit" | null>(null);
	const reduced = useReducedMotion();
	const pending = approval.status === "pending";

	useEffect(() => {
		if (!editing) return;
		const frame = window.requestAnimationFrame(() =>
			textareaRef.current?.focus(),
		);
		return () => window.cancelAnimationFrame(frame);
	}, [editing]);

	useEffect(() => {
		if (focusRequest === 0) return;
		const frame = window.requestAnimationFrame(() => {
			const requested = focusTargetRef.current;
			focusTargetRef.current = null;
			const target = requested === "edit" ? editButtonRef.current : requested;
			if (target?.isConnected) target.focus();
			else titleRef.current?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [focusRequest]);

	function restoreFocus(target: HTMLElement | "edit") {
		focusTargetRef.current = target;
		setFocusRequest((request) => request + 1);
	}

	async function run(
		kind: "approve" | "reject" | "save",
		action: () => Promise<void>,
		origin: HTMLButtonElement,
	) {
		setActionError("");
		setBusy(kind);
		let succeeded = false;
		try {
			await action();
			succeeded = true;
			if (kind === "save") setEditing(false);
		} catch (cause) {
			setActionError(
				cause instanceof Error && cause.message.trim()
					? cause.message
					: "Kestrel could not resolve this approval. Nothing was changed.",
			);
		} finally {
			setBusy(null);
			restoreFocus(kind === "save" && succeeded ? "edit" : origin);
		}
	}

	return (
		<article className="approval-card" aria-labelledby={`${approval.id}-title`}>
			<header className="approval-header">
				<div>
					<span className="eyebrow">
						Approval level {approval.approvalLevel} · external communication
					</span>
					<h2 ref={titleRef} tabIndex={-1} id={`${approval.id}-title`}>
						{approval.title}
					</h2>
				</div>
				<span className={`status status-${approval.status}`}>
					{approval.status.replace("_", " ")}
				</span>
			</header>

			<div className="recommendation-line">
				<span>{approval.recommendation}</span>
				<p>{approval.reasoning}</p>
			</div>

			<div className="proposal-grid">
				<section className="proposal-block email-block">
					<div className="proposal-label">
						<span>Email draft</span>
						<span>to {approval.proposedEmail.to.split("<")[0]}</span>
					</div>
					<strong>{approval.proposedEmail.subject}</strong>
					{editing ? (
						<label className="edit-field">
							Message body
							<textarea
								ref={textareaRef}
								value={body}
								onChange={(event) => setBody(event.target.value)}
								rows={7}
							/>
						</label>
					) : (
						<pre>{approval.proposedEmail.body}</pre>
					)}
				</section>
				<section className="proposal-block">
					<div className="proposal-label">
						<span>Calendar</span>
						<span>{approval.proposedCalendarEvent.durationMinutes} min</span>
					</div>
					<strong>{approval.proposedCalendarEvent.title}</strong>
					<p>{approval.proposedCalendarEvent.startsAt}</p>
					<div className="study-list">
						{approval.proposedStudyBlocks.map((block) => (
							<div key={block.startsAt}>
								<span>{block.label}</span>
								<small>{block.startsAt}</small>
							</div>
						))}
					</div>
				</section>
			</div>

			<details className="evidence-list">
				<summary>{approval.evidence.length} evidence items used</summary>
				{approval.evidence.map((item) => (
					<div className="evidence-row" key={item.id}>
						<Icon name="check" />
						<span>
							<strong>{item.label}</strong>
							{item.value}
						</span>
						<small>{item.source}</small>
					</div>
				))}
			</details>

			{actionError && (
				<p className="approval-error" role="alert">
					{actionError}
				</p>
			)}

			<AnimatePresence initial={false}>
				{pending && (
					<motion.footer
						className="approval-actions"
						initial={reduced ? false : { opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0 }}
					>
						<label className="policy-check">
							<input
								type="checkbox"
								disabled
								aria-label="Policy suggestion preview only"
								title="Preview only — policy editing arrives with real connector setup"
							/>
							<span>
								{approval.policySuggestion}
								<small>Policy editing arrives with real connector setup.</small>
							</span>
						</label>
						<div className="button-row">
							{editing ? (
								<>
									<button
										className="button secondary"
										onClick={() => {
											setActionError("");
											setEditing(false);
											setBody(approval.proposedEmail.body);
											restoreFocus("edit");
										}}
									>
										Cancel
									</button>
									<button
										className="button primary"
										disabled={busy !== null || body.trim().length === 0}
										onClick={(event) =>
											void run("save", () => onEdit(body), event.currentTarget)
										}
									>
										{busy === "save" ? "Saving…" : "Save draft"}
									</button>
								</>
							) : (
								<>
									<button
										className="button quiet"
										disabled={busy !== null}
										onClick={(event) =>
											void run("reject", onReject, event.currentTarget)
										}
									>
										{busy === "reject" ? "Rejecting…" : "Reject"}
									</button>
									<button
										ref={editButtonRef}
										className="button secondary"
										disabled={busy !== null}
										onClick={() => {
											setActionError("");
											setEditing(true);
										}}
									>
										Edit
									</button>
									<button
										className="button primary"
										disabled={busy !== null}
										onClick={(event) =>
											void run("approve", onApprove, event.currentTarget)
										}
									>
										{busy === "approve" ? "Finalizing…" : "Approve plan"}
										<Icon name="arrow" />
									</button>
								</>
							)}
						</div>
					</motion.footer>
				)}
			</AnimatePresence>
		</article>
	);
}
