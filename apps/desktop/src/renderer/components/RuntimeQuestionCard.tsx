import type {
	CoreResponse,
	HumanInputAnswer,
	HumanInputRequest,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";

function statusLabel(status: HumanInputRequest["status"]): string {
	switch (status) {
		case "waiting":
			return "Waiting for your answer";
		case "answered":
			return "Answered";
		case "skipped":
			return "Skipped";
		case "timed_out":
			return "Timed out";
		case "cancelled":
			return "Cancelled";
		case "replaced":
			return "Replaced by a newer question";
		case "completed":
			return "Run completed";
	}
}

export const QUESTION_FOCUSABLE_SELECTOR = "input, textarea, button";

/** Focus the first native control so keyboard users can answer an inline card. */
export function focusQuestionCardControl(card: HTMLElement | null): void {
	card?.querySelector<HTMLElement>(QUESTION_FOCUSABLE_SELECTOR)?.focus();
}

export function RuntimeQuestionCard({
	request,
	onResolved,
}: {
	request: HumanInputRequest;
	onResolved?(request: HumanInputRequest): void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const [answerMode, setAnswerMode] = useState<"choice" | "free_text">(
		request.options.length > 0 ? "choice" : "free_text",
	);
	const [freeText, setFreeText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const cardRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		setSelected([]);
		setFreeText("");
		setAnswerMode(request.options.length > 0 ? "choice" : "free_text");
		setError("");
	}, [request.id, request.options.length]);

	useEffect(() => {
		if (request.status !== "waiting") return;
		focusQuestionCardControl(cardRef.current);
	}, [request.id, request.status]);

	const canSubmit = useMemo(() => {
		if (submitting || request.status !== "waiting") return false;
		if (answerMode === "free_text") return request.allowFreeText && Boolean(freeText.trim());
		return selected.length > 0;
	}, [answerMode, freeText, request.allowFreeText, request.status, selected.length, submitting]);

	function toggleOption(optionId: string) {
		setSelected((current) => {
			if (request.selectionMode === "multiple")
				return current.includes(optionId)
					? current.filter((id) => id !== optionId)
					: [...current, optionId];
			return [optionId];
		});
	}

	async function send(answer: HumanInputAnswer) {
		if (submitting || request.status !== "waiting") return;
		setSubmitting(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-answer-human-input",
				requestId: request.id,
				runId: request.runId,
				answer,
			})) as CoreResponse;
			if (!response.ok || !response.humanInput)
				throw new Error(response.ok ? "The question did not return an updated state." : response.error);
			onResolved?.(response.humanInput);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not send this answer.");
		} finally {
			setSubmitting(false);
		}
	}

	async function cancel() {
		if (submitting || request.status !== "waiting") return;
		setSubmitting(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-cancel-human-input",
				requestId: request.id,
				runId: request.runId,
			})) as CoreResponse;
			if (!response.ok || !response.humanInput)
				throw new Error(response.ok ? "The question did not return an updated state." : response.error);
			onResolved?.(response.humanInput);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not cancel this question.");
		} finally {
			setSubmitting(false);
		}
	}

	if (request.status !== "waiting")
		return (
			<article
				className="runtime-question-card runtime-question-card-terminal"
				ref={cardRef}
				tabIndex={-1}
				data-human-input-id={request.id}
			>
				<strong>{request.prompt}</strong>
				<span role="status">{statusLabel(request.status)}</span>
			</article>
		);

	return (
		<article
			className="runtime-question-card"
			ref={cardRef}
			tabIndex={-1}
			aria-labelledby={`human-input-prompt-${request.id}`}
			data-human-input-id={request.id}
		>
			<div className="runtime-question-heading">
				<div>
					<span className="runtime-section-label">Kestrel needs your input</span>
					<h3 id={`human-input-prompt-${request.id}`}>{request.prompt}</h3>
				</div>
				<span className="runtime-question-status" role="status">
					{request.expiresAt ? `Due ${new Date(request.expiresAt).toLocaleTimeString()}` : "Waiting"}
				</span>
			</div>
			{request.context ? <p className="runtime-question-context">{request.context}</p> : null}

			{request.options.length > 0 && answerMode === "choice" ? (
				<fieldset className="runtime-question-options">
					<legend className="sr-only">
						{request.selectionMode === "multiple" ? "Choose one or more options" : "Choose one option"}
					</legend>
					{request.options.map((option) => {
						const checked = selected.includes(option.id);
						return (
							<label className={checked ? "selected" : ""} key={option.id}>
								<input
									type={request.selectionMode === "multiple" ? "checkbox" : "radio"}
									name={`human-input-${request.id}`}
									value={option.id}
									checked={checked}
									onChange={() => toggleOption(option.id)}
								/>
								<span>
									<strong>{option.label}</strong>
									{option.description ? <small>{option.description}</small> : null}
								</span>
							</label>
						);
					})}
				</fieldset>
			) : request.allowFreeText ? (
				<label className="runtime-question-free-text">
					<span>Answer in your own words</span>
					<textarea
						value={freeText}
						onChange={(event) => setFreeText(event.target.value)}
						rows={3}
						maxLength={20_000}
						placeholder="Type an answer…"
					/>
				</label>
			) : null}

			<div className="runtime-question-actions">
				{request.options.length > 0 && request.allowFreeText ? (
					<button
						type="button"
						className="quiet-link"
						onClick={() => setAnswerMode(answerMode === "choice" ? "free_text" : "choice")}
					>
						{answerMode === "choice" ? "Answer with text instead" : "Choose an option instead"}
					</button>
				) : null}
				<div className="button-row">
					{request.allowSkip ? (
						<button type="button" className="button secondary" disabled={submitting} onClick={() => void send({ kind: "skip" })}>
							Skip
						</button>
					) : null}
					<button type="button" className="button secondary" disabled={submitting} onClick={() => void cancel()}>
						Cancel
					</button>
					<button
						type="button"
						className="button primary"
						disabled={!canSubmit}
						onClick={() =>
							void send(
								answerMode === "free_text"
									? { kind: "free_text", text: freeText.trim() }
										: request.selectionMode === "multiple"
											? { kind: "multi_choice", optionIds: selected }
											: { kind: "single_choice", optionId: selected[0]! },
								)
							}
					>
						{ submitting ? "Sending…" : "Submit answer"}
					</button>
				</div>
			</div>
			{error ? <p className="chat-error" role="alert">{error}</p> : null}
		</article>
	);
}
