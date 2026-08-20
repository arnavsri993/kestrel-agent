import type { GoalRecordContract, RuntimeSession } from "@kestrel/shared-types";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { sessionTitleForDisplay } from "../chat-title";

type TaskStatus = GoalRecordContract["tasks"][number]["status"];

interface GoalKanbanProps {
	goals: GoalRecordContract[];
	sessions: RuntimeSession[];
	busy: boolean;
	onTaskUpdate(input: {
		goalId: string;
		taskId: string;
		taskStatus?: TaskStatus;
		assigneeSessionId?: string | null;
	}): Promise<boolean>;
	onCompleteGoal(goalId: string): Promise<boolean>;
}

const columns: Array<{ status: TaskStatus; label: string }> = [
	{ status: "pending", label: "Ready" },
	{ status: "in_progress", label: "In progress" },
	{ status: "completed", label: "Done" },
];

function statusLabel(status: TaskStatus): string {
	return columns.find((column) => column.status === status)?.label ?? status;
}

export function GoalKanban({
	goals,
	sessions,
	busy,
	onTaskUpdate,
	onCompleteGoal,
}: GoalKanbanProps) {
	const activeGoals = useMemo(
		() => goals.filter((goal) => goal.status === "active"),
		[goals],
	);
	const activeSessionIds = useMemo(
		() => new Set(activeGoals.map((goal) => goal.sessionId)),
		[activeGoals],
	);
	const workers = useMemo(
		() =>
			sessions.filter(
				(session) =>
					session.parentSessionId &&
					activeSessionIds.has(session.parentSessionId),
			),
		[activeSessionIds, sessions],
	);
	const [dragged, setDragged] = useState<{
		goalId: string;
		taskId: string;
		status: TaskStatus;
	} | null>(null);
	const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [focusTaskId, setFocusTaskId] = useState("");
	const cardRefs = useRef(new Map<string, HTMLElement>());

	useEffect(() => {
		if (!focusTaskId || busy) return;
		const card = cardRefs.current.get(focusTaskId);
		if (!card) return;
		card.focus();
		setFocusTaskId("");
	}, [busy, focusTaskId, goals]);

	const taskCount = activeGoals.reduce(
		(total, goal) => total + goal.tasks.length,
		0,
	);
	const completedCount = activeGoals.reduce(
		(total, goal) =>
			total + goal.tasks.filter((task) => task.status === "completed").length,
		0,
	);

	async function moveTask(
		goalId: string,
		taskId: string,
		from: TaskStatus,
		to: TaskStatus,
		restoreFocus: boolean,
	) {
		if (from === to || busy) return;
		const succeeded = await onTaskUpdate({ goalId, taskId, taskStatus: to });
		if (!succeeded) return;
		setAnnouncement(
			`Task moved from ${statusLabel(from)} to ${statusLabel(to)}.`,
		);
		if (restoreFocus) setFocusTaskId(taskId);
	}

	async function assignTask(
		goalId: string,
		taskId: string,
		assigneeSessionId: string | null,
	) {
		const succeeded = await onTaskUpdate({ goalId, taskId, assigneeSessionId });
		if (!succeeded) return;
		const worker = workers.find((session) => session.id === assigneeSessionId);
		setAnnouncement(
			worker
				? `Task assigned to ${sessionTitleForDisplay(worker.title)}.`
				: "Task returned to the local operator.",
		);
	}

	function startDrag(
		event: DragEvent<HTMLElement>,
		goalId: string,
		taskId: string,
		status: TaskStatus,
	) {
		setDragged({ goalId, taskId, status });
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", `${goalId}:${taskId}`);
	}

	function finishDrag() {
		setDragged(null);
		setDropTarget(null);
	}

	return (
		<section className="kanban" aria-labelledby="kanban-heading">
			<header className="kanban-header">
				<div>
					<h2 id="kanban-heading">Goal board</h2>
				</div>
				<dl className="kanban-tally" aria-label="Board totals">
					<div>
						<dt>Goals</dt>
						<dd>{activeGoals.length}</dd>
					</div>
					<div>
						<dt>Tasks</dt>
						<dd>{taskCount}</dd>
					</div>
					<div>
						<dt>Done</dt>
						<dd>{completedCount}</dd>
					</div>
				</dl>
			</header>

			<div className="worker-lanes" aria-labelledby="worker-lanes-heading">
				<div className="worker-lanes-title">
					<span id="worker-lanes-heading">Worker lanes</span>
				</div>
				{workers.length > 0 ? (
					<ul>
						{workers.map((worker) => {
							const assigned = activeGoals.reduce(
								(total, goal) =>
									total +
									goal.tasks.filter(
										(task) => task.assigneeSessionId === worker.id,
									).length,
								0,
							);
							return (
								<li key={worker.id}>
									<span
										className={`agent-dot ${worker.status === "active" ? "working" : worker.status === "waiting" ? "paused" : "idle"}`}
									/>
									<strong>{sessionTitleForDisplay(worker.title)}</strong>
									<small>
										{worker.status.replaceAll("_", " ")} · {assigned} assigned
									</small>
								</li>
							);
						})}
					</ul>
				) : (
					<p>
						No worker lanes are configured. Cards remain with the local
						operator.
					</p>
				)}
			</div>

			{activeGoals.length === 0 ? (
				<div className="kanban-empty-board">
					<strong>No active goals</strong>
					<p>Create a goal and its task lines will appear here.</p>
				</div>
			) : (
				<div className="kanban-columns">
					{columns.map((column, columnIndex) => {
						const cards = activeGoals.flatMap((goal) =>
							goal.tasks
								.filter((task) => task.status === column.status)
								.map((task) => ({ goal, task })),
						);
						const isDropTarget =
							dropTarget === column.status && dragged?.status !== column.status;
						return (
							<section
								className={`kanban-column${isDropTarget ? " drop-target" : ""}`}
								key={column.status}
								aria-labelledby={`kanban-${column.status}`}
								onDragOver={(event) => {
									if (!dragged || dragged.status === column.status || busy)
										return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									setDropTarget(column.status);
								}}
								onDragLeave={(event) => {
									if (
										!event.currentTarget.contains(
											event.relatedTarget as Node | null,
										)
									)
										setDropTarget(null);
								}}
								onDrop={(event) => {
									event.preventDefault();
									const active = dragged;
									finishDrag();
									if (active)
										void moveTask(
											active.goalId,
											active.taskId,
											active.status,
											column.status,
											false,
										);
								}}
							>
								<header>
									<div>
										<h3 id={`kanban-${column.status}`}>{column.label}</h3>
									</div>
									<span aria-label={`${cards.length} tasks`}>
										{String(cards.length).padStart(2, "0")}
									</span>
								</header>
								<div className="kanban-card-stack">
									{cards.length === 0 && (
										<p className="kanban-column-empty">
											{isDropTarget
												? `Release to move into ${column.label}.`
												: `No tasks in ${column.label.toLowerCase()}.`}
										</p>
									)}
									{cards.map(({ goal, task }) => {
										const workerOptions = workers.filter(
											(worker) => worker.parentSessionId === goal.sessionId,
										);
										return (
											<article
												className={`kanban-card${dragged?.taskId === task.id ? " dragging" : ""}`}
												draggable={!busy}
												key={task.id}
												ref={(node) => {
													if (node) cardRefs.current.set(task.id, node);
													else cardRefs.current.delete(task.id);
												}}
												tabIndex={-1}
												onDragStart={(event) =>
													startDrag(event, goal.id, task.id, task.status)
												}
												onDragEnd={finishDrag}
											>
												<div className="kanban-card-meta">
													<span>{goal.title}</span>
													<span aria-hidden="true">⋮⋮</span>
												</div>
												<h4>{task.title}</h4>
												{task.dueAt && (
													<time dateTime={task.dueAt}>
														Due {new Date(task.dueAt).toLocaleString()}
													</time>
												)}
												<label>
													Worker lane
													<select
														value={task.assigneeSessionId ?? ""}
														disabled={busy}
														onChange={(event) =>
															void assignTask(
																goal.id,
																task.id,
																event.target.value || null,
															)
														}
													>
														<option value="">Local operator</option>
														{workerOptions.map((worker) => (
															<option key={worker.id} value={worker.id}>
																{sessionTitleForDisplay(worker.title)}
															</option>
														))}
													</select>
												</label>
												<div className="kanban-card-actions">
													{columnIndex > 0 && (
														<button
															type="button"
															disabled={busy}
															onClick={() =>
																void moveTask(
																	goal.id,
																	task.id,
																	task.status,
																	columns[columnIndex - 1]!.status,
																	true,
																)
															}
														>
															← {columns[columnIndex - 1]!.label}
														</button>
													)}
													{columnIndex < columns.length - 1 && (
														<button
															type="button"
															disabled={busy}
															onClick={() =>
																void moveTask(
																	goal.id,
																	task.id,
																	task.status,
																	columns[columnIndex + 1]!.status,
																	true,
																)
															}
														>
															{columns[columnIndex + 1]!.label} →
														</button>
													)}
												</div>
											</article>
										);
									})}
								</div>
							</section>
						);
					})}
				</div>
			)}

			{activeGoals.length > 0 && (
				<div className="goal-ledger" aria-label="Active goal summary">
					{activeGoals.map((goal) => {
						const done = goal.tasks.filter(
							(task) => task.status === "completed",
						).length;
						return (
							<article key={goal.id}>
								<div>
									<strong>{goal.title}</strong>
									<p>{goal.objective}</p>
									<small>
										{done}/{goal.tasks.length} tasks done
										{goal.deadline
											? ` · deadline ${new Date(goal.deadline).toLocaleString()}`
											: ""}
									</small>
								</div>
								<button
									className="button secondary"
									disabled={busy}
									onClick={() => void onCompleteGoal(goal.id)}
								>
									Complete goal
								</button>
							</article>
						);
					})}
				</div>
			)}
			<p className="sr-only" role="status" aria-live="polite">
				{announcement}
			</p>
		</section>
	);
}
