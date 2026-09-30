#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const captureArgument = process.argv.find((value) =>
	value.startsWith("--kestrel-test-capture="),
);
const capturePath = captureArgument?.slice("--kestrel-test-capture=".length);
let turn = 0;
let taskTurn = 0;
const pendingTurns = new Map();

function record(direction, value) {
	if (capturePath)
		appendFileSync(capturePath, `${JSON.stringify({ direction, value })}\n`);
}

function send(value) {
	record("out", value);
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		continue;
	}
	if (message.id === undefined) continue;
	record("in", message);
	if (typeof message.id === "number" && !message.method) {
		const pending = pendingTurns.get(message.id);
		if (!pending) continue;
		pendingTurns.delete(message.id);
		send({
			method: "item/agentMessage/delta",
			params: {
				threadId: "fixture-thread",
				turnId: pending.turnId,
				itemId: `fixture-answer-${pending.turnId}`,
				delta: pending.response,
			},
		});
		send({
			method: "turn/completed",
			params: {
				threadId: "fixture-thread",
				turn: { id: pending.turnId, status: "completed", error: null },
			},
		});
	} else if (message.method === "initialize") {
		send({ id: message.id, result: { userAgent: "kestrel-readiness-fixture" } });
	} else if (message.method === "account/read") {
		send({
			id: message.id,
			result: { account: { type: "chatgpt", email: "fixture@example.test" } },
		});
	} else if (message.method === "model/list") {
		send({
			id: message.id,
			result: {
				data: [
					{
						id: "gpt-6-sol",
						model: "gpt-6-sol",
						displayName: "GPT-6 Sol",
						supportedReasoningEfforts: [
							{ reasoningEffort: "low" },
							{ reasoningEffort: "medium" },
							{ reasoningEffort: "high" },
							{ reasoningEffort: "xhigh" },
							{ reasoningEffort: "max" },
							{ reasoningEffort: "ultra" },
						],
					},
					{
						id: "gpt-6-luna",
						model: "gpt-6-luna",
						displayName: "GPT-6 Luna",
						supportedReasoningEfforts: [
							{ reasoningEffort: "low" },
							{ reasoningEffort: "medium" },
							{ reasoningEffort: "high" },
							{ reasoningEffort: "xhigh" },
							{ reasoningEffort: "max" },
						],
					},
				],
				nextCursor: null,
			},
		});
	} else if (message.method === "thread/start") {
		send({ id: message.id, result: { thread: { id: "fixture-thread" } } });
	} else if (message.method === "thread/resume") {
		send({ id: message.id, result: { thread: { id: message.params?.threadId } } });
	} else if (message.method === "turn/start") {
		turn += 1;
		const turnId = `fixture-turn-${turn}`;
		const taskRequest = JSON.stringify(message.params?.input ?? []).includes(
			"Return the fixture response without changing files or using the network.",
		);
		const response = taskRequest
			? `Fixture read-only response ${++taskTurn}.`
			: "Welcome back.";
		send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
		const approvalRequestId = 10_000 + turn;
		pendingTurns.set(approvalRequestId, { turnId, response });
		send({
			id: approvalRequestId,
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "fixture-thread",
				turnId,
				itemId: `fixture-command-${turn}`,
				command: "touch forbidden-by-readiness-fixture",
			},
		});
	} else {
		send({ id: message.id, result: {} });
	}
}
