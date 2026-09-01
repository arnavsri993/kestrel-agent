import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import {
	HumanInputAnswerSchema,
	HumanInputRequestSchema,
	type HumanInputAnswer,
	type HumanInputRequest,
	type HumanInputRequestStatus,
} from "@kestrel/shared-types";

export type { HumanInputRequest } from "@kestrel/shared-types";

const HUMAN_INPUT_STATE_KEY = "runtime.human-input.requests";
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_input"]);

export type HumanInputRunStatus =
	| "running"
	| "waiting_approval"
	| "waiting_input"
	| "completed"
	| "cancelled"
	| "failed"
	| "missing";

export interface HumanInputCreateInput {
	requestId?: string;
	sessionId: string;
	runId: string;
	prompt: string;
	context?: string;
	options?: HumanInputRequest["options"];
	selectionMode?: HumanInputRequest["selectionMode"];
	allowFreeText: boolean;
	allowSkip: boolean;
	timeoutMs?: number;
}

export interface HumanInputAnswerInput {
	requestId: string;
	runId: string;
	answer: HumanInputAnswer;
}

export interface HumanInputManagerOptions {
	now?: () => Date;
	getRunStatus: (runId: string) => HumanInputRunStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function statusForRun(status: HumanInputRunStatus): HumanInputRequestStatus {
	return status === "completed" ? "completed" : "cancelled";
}

function cloneRequests(value: unknown): HumanInputRequest[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const parsed = HumanInputRequestSchema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
}

/**
 * Encrypted, run-bound human input state. The manager intentionally has no
 * mutation or approval capability: an answer is data for the owning run and
 * never an approval grant.
 */
export class HumanInputManager {
	private readonly now: () => Date;
	private readonly getRunStatus: HumanInputManagerOptions["getRunStatus"];

	constructor(
		private readonly database: KestrelDatabase,
		options: HumanInputManagerOptions,
	) {
		this.now = options.now ?? (() => new Date());
		this.getRunStatus = options.getRunStatus;
	}

	list(sessionId?: string): HumanInputRequest[] {
		const requests = this.reconcile(cloneRequests(this.database.getPrivateState(HUMAN_INPUT_STATE_KEY)));
		return sessionId ? requests.filter((request) => request.sessionId === sessionId) : requests;
	}

	create(input: HumanInputCreateInput): HumanInputRequest {
		if (!input.sessionId || !input.runId) throw new Error("Human input ownership is required.");
		if (!input.prompt.trim()) throw new Error("Human input prompt is required.");
		if ((input.options?.length ?? 0) > 0 && !input.selectionMode)
			throw new Error("Choice options require a selection mode.");
		if (input.selectionMode === "single" && (input.options?.length ?? 0) === 0)
			throw new Error("Single-choice input requires options.");
		if (input.selectionMode === "multiple" && (input.options?.length ?? 0) === 0)
			throw new Error("Multiple-choice input requires options.");
		if (input.timeoutMs !== undefined &&
			(!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 7 * 24 * 60 * 60 * 1_000))
			throw new Error("Human input timeout is invalid.");

		const now = this.now();
		const createdAt = now.toISOString();
		const requests = this.reconcile(cloneRequests(this.database.getPrivateState(HUMAN_INPUT_STATE_KEY)));
		const replaced = requests.map((request) =>
			request.sessionId === input.sessionId &&
			request.runId === input.runId &&
			request.status === "waiting"
				? {
						...request,
						status: "replaced" as const,
						terminalReason: "A newer question replaced this request.",
						answeredAt: createdAt,
					}
				: request,
		);
		const request = HumanInputRequestSchema.parse({
			id: input.requestId ?? `human-input-${randomUUID()}`,
			sessionId: input.sessionId,
			runId: input.runId,
			prompt: input.prompt.trim(),
			...(input.context?.trim() ? { context: input.context.trim() } : {}),
			options: input.options ?? [],
			...(input.selectionMode ? { selectionMode: input.selectionMode } : {}),
			allowFreeText: input.allowFreeText,
			allowSkip: input.allowSkip,
			status: "waiting",
			createdAt,
			...(input.timeoutMs !== undefined
				? { expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString() }
				: {}),
		});
		this.save([...replaced, request]);
		return request;
	}

	answer(input: HumanInputAnswerInput): HumanInputRequest {
		const answer = HumanInputAnswerSchema.parse(input.answer);
		const requests = this.reconcile(cloneRequests(this.database.getPrivateState(HUMAN_INPUT_STATE_KEY)));
		const current = requests.find((request) => request.id === input.requestId);
		if (!current) throw new Error("Human input request was not found.");
		if (current.runId !== input.runId)
			throw new Error("Human input request does not belong to this run.");
		if (current.status !== "waiting")
			throw new Error(`Human input request is ${current.status} and cannot accept an answer.`);
		const runStatus = this.getRunStatus(current.runId);
		if (!ACTIVE_RUN_STATUSES.has(runStatus)) {
			const status = statusForRun(runStatus);
			const terminal = { ...current, status, terminalReason: "The owning run is no longer active." };
			this.save(requests.map((request) => request.id === current.id ? terminal : request));
			throw new Error("The owning run is no longer authorized to accept this answer.");
		}
		this.assertNotExpired(current, requests);
		this.validateAnswer(current, answer);
		const answeredAt = this.now().toISOString();
		const updated = {
			...current,
			status: answer.kind === "skip" ? ("skipped" as const) : ("answered" as const),
			answer,
			answeredAt,
		};
		this.save(requests.map((request) => request.id === current.id ? updated : request));
		return updated;
	}

	cancel(requestId: string, runId: string): HumanInputRequest {
		return this.finish(requestId, runId, "cancelled", "Cancelled by the user.");
	}

	completeForRun(runId: string, status: Exclude<HumanInputRequestStatus, "waiting" | "answered" | "skipped"> = "completed"): void {
		const requests = cloneRequests(this.database.getPrivateState(HUMAN_INPUT_STATE_KEY));
		const terminalAt = this.now().toISOString();
		const next = requests.map((request) =>
			request.runId === runId && request.status === "waiting"
				? { ...request, status, answeredAt: terminalAt, terminalReason: "The owning run ended." }
				: request,
		);
		this.save(next);
	}

	private finish(
		requestId: string,
		runId: string,
		status: Exclude<HumanInputRequestStatus, "waiting" | "answered" | "skipped">,
		reason: string,
	): HumanInputRequest {
		const requests = this.reconcile(cloneRequests(this.database.getPrivateState(HUMAN_INPUT_STATE_KEY)));
		const current = requests.find((request) => request.id === requestId);
		if (!current) throw new Error("Human input request was not found.");
		if (current.runId !== runId) throw new Error("Human input request does not belong to this run.");
		if (current.status !== "waiting") throw new Error(`Human input request is ${current.status} and cannot be cancelled.`);
		const updated = { ...current, status, answeredAt: this.now().toISOString(), terminalReason: reason };
		this.save(requests.map((request) => request.id === current.id ? updated : request));
		return updated;
	}

	private reconcile(requests: HumanInputRequest[]): HumanInputRequest[] {
		let changed = false;
		const next = requests.map((request) => {
			if (request.status !== "waiting") return request;
			const runStatus = this.getRunStatus(request.runId);
			if (ACTIVE_RUN_STATUSES.has(runStatus) &&
				(!request.expiresAt || Date.parse(request.expiresAt) > this.now().getTime()))
				return request;
			changed = true;
			if (request.expiresAt && Date.parse(request.expiresAt) <= this.now().getTime())
				return { ...request, status: "timed_out" as const, answeredAt: this.now().toISOString(), terminalReason: "The question timed out." };
			return { ...request, status: statusForRun(runStatus), answeredAt: this.now().toISOString(), terminalReason: "The owning run is no longer active." };
		});
		if (changed) this.save(next);
		return next;
	}

	private assertNotExpired(current: HumanInputRequest, requests: HumanInputRequest[]): void {
		if (!current.expiresAt || Date.parse(current.expiresAt) > this.now().getTime()) return;
		const updated = { ...current, status: "timed_out" as const, answeredAt: this.now().toISOString(), terminalReason: "The question timed out." };
		this.save(requests.map((request) => request.id === current.id ? updated : request));
		throw new Error("Human input request timed out.");
	}

	private validateAnswer(request: HumanInputRequest, answer: HumanInputAnswer): void {
		if (answer.kind === "skip") {
			if (!request.allowSkip) throw new Error("Skipping this question is not allowed.");
			return;
		}
		if (answer.kind === "free_text") {
			if (!request.allowFreeText) throw new Error("Free-text answers are not allowed for this question.");
			if (!answer.text.trim()) throw new Error("A free-text answer cannot be empty.");
			return;
		}
		if (!request.selectionMode) throw new Error("This question does not accept a choice answer.");
		const optionIds = answer.kind === "single_choice" ? [answer.optionId] : answer.optionIds;
		if (request.selectionMode === "single" && answer.kind !== "single_choice")
			throw new Error("This question accepts one choice only.");
		if (request.selectionMode === "multiple" && answer.kind !== "multi_choice")
			throw new Error("This question accepts multiple choices only.");
		const allowed = new Set(request.options.map((option) => option.id));
		if (optionIds.some((id) => !allowed.has(id))) throw new Error("The answer contains an unknown option.");
		if (new Set(optionIds).size !== optionIds.length) throw new Error("The answer contains a duplicate option.");
	}

	private save(requests: HumanInputRequest[]): void {
		this.database.setPrivateState(
			HUMAN_INPUT_STATE_KEY,
			requests.map((request) => HumanInputRequestSchema.parse(request)),
		);
	}
}

export function isHumanInputRecord(value: unknown): value is HumanInputRequest {
	return isRecord(value) && HumanInputRequestSchema.safeParse(value).success;
}
