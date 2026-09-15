import { ScopedLifeView } from "./ScopedLifeView";
import { MemoryRecovery } from "./MemoryRecovery";
import { SourceMemoryView } from "./SourceMemoryView";
import { useEffect, useState } from "react";
import type { AgentIdentity, AgentMemoryRecord, WorkingTask, CoreResponse } from "@kestrel/shared-types";

/** Privileged user inspection; never exposed as an unscoped model retrieval tool. */
export function ScopedAgentMemory({ sessionId }: { sessionId: string }) {
	const [data, setData] = useState<{ identity: AgentIdentity; memories: AgentMemoryRecord[]; tasks: WorkingTask[]; owners: Array<{ sessionId: string; name: string }>; memoryNextOffset?: number | undefined; taskNextOffset?: number | undefined }>();
	const [includeSpecialists, setIncludeSpecialists] = useState(true);
	const [memoryOffset, setMemoryOffset] = useState(0);
	const [taskOffset, setTaskOffset] = useState(0);
	const [query, setQuery] = useState("");
	const [view, setView] = useState<"knowledge" | "work" | "sources" | "people" | "calendar">("knowledge");
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setData(undefined);
		setError("");
		void window.kestrel.request({ type: "memory-agent-inspect", sessionId, includeInactive: false, includeSpecialists, limit: 200, memoryOffset, taskOffset }).then(raw => {
			const result = raw as CoreResponse;
			if (!result.ok) throw new Error(result.error);
			if (!result.memoryAgentIdentity) throw new Error("Agent memory is unavailable.");
			if (active) setData({ identity: result.memoryAgentIdentity, memories: result.memoryAgentMemories ?? [], tasks: result.memoryAgentTasks ?? [], owners: result.memoryTaskOwners ?? [], memoryNextOffset: result.memoryNextOffset, taskNextOffset: result.taskNextOffset });
		}).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load memory."); });
		return () => { active = false; };
	}, [sessionId, revision, includeSpecialists, memoryOffset, taskOffset]);
	async function correct(id: string, content: string) {
		try {
			const result = await window.kestrel.request({ type: "memory-agent-correct", sessionId, id, content });
			if (!result.ok) throw new Error(result.error);
			setRevision(value => value + 1);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Correction failed."); }
	}
	const matches = (text: string) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
	return <section className="life-page scoped-agent-memory" aria-label="Scoped agent memory">
		<header className="page-header"><h1>{data ? `${data.identity.name} memory` : "Agent memory"}</h1></header>
		<MemoryRecovery key={sessionId} sessionId={sessionId} onRestored={() => setRevision(value => value + 1)} />
		<label className="scoped-memory-search">Search this scope<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
		<nav className="life-switcher" aria-label="Agent memory views">
			{(["knowledge", "work", "sources", "people", "calendar"] as const).map(id => <button type="button" key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{id === "knowledge" ? "Knowledge" : id === "sources" ? "Sources" : id === "people" ? "People" : id === "calendar" ? "Calendar" : "Work history"}</button>)}
		</nav>
		{error && <p role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
		{!data && !error && <p role="status">Loading this agent’s memory…</p>}
		{(view === "people" || view === "calendar") && <ScopedLifeView key={`${sessionId}:${view}`} sessionId={sessionId} view={view} />}
		{view === "sources" && <SourceMemoryView key={sessionId} sessionId={sessionId} onQueued={() => setRevision(value => value + 1)} />}
		{data && view === "knowledge" && <>
			<p>Private to this agent. Search filters this page of up to 200 records.</p>
			{data.memories.filter(item => matches(item.content)).map(item => <details key={item.id}>
				<summary>{item.content.slice(0, 160)}</summary>
				<p>{item.content}</p>
				<p>{item.kind} · {item.status} · {new Date(item.createdAt).toLocaleString()}</p>
				<details><summary>Source references</summary><ul>{item.sourceIds.map(id => <li key={id}>{id}</li>)}</ul></details>
				<form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void correct(item.id, String(form.get("content") ?? "")); }}>
					<label>Correct this memory<textarea name="content" defaultValue={item.content} required maxLength={100000} /></label>
					<button type="submit">Save correction</button>
				</form>
			</details>)}
			{!data.memories.some(item => matches(item.content)) && <p>No matching memories on this page.</p>}
			<div><button disabled={memoryOffset === 0} onClick={() => setMemoryOffset(Math.max(0, memoryOffset - 200))}>Previous memories</button><span> Page {Math.floor(memoryOffset / 200) + 1} </span><button disabled={data.memoryNextOffset === undefined} onClick={() => setMemoryOffset(data.memoryNextOffset!)}>Next memories</button></div>
		</>}
		{data && view === "work" && <>
			<label><input type="checkbox" checked={includeSpecialists} onChange={event => { setIncludeSpecialists(event.target.checked); setTaskOffset(0); }} />Include specialist work</label>
			<p>Up to 100 tasks per page. Search filters this page. Reported progress and failed attempts remain distinct from verified results.</p>
			{data.tasks.filter(item => matches(item.goal)).map(item => <details key={item.id}>
				<summary>{data.owners.find(owner => owner.sessionId === item.sessionId)?.name ?? data.identity.name} · {item.goal.slice(0, 160)} · {item.status}</summary>
				<p>{item.goal}</p><p>{item.unresolvedQuestions.join(" · ")}</p>
				{item.outcomeSummary && <p>{item.outcomeSummary}</p>}
				{item.failures.length > 0 && <p>Unresolved: {item.failures.join(" · ")}</p>}
				<ul>{item.evidence.map((evidence, index) => <li key={index}>{evidence.label ?? evidence.type}: {evidence.id}</li>)}</ul>
			</details>)}
			{!data.tasks.some(item => matches(item.goal)) && <p>No matching work on this page.</p>}
			<div><button disabled={taskOffset === 0} onClick={() => setTaskOffset(Math.max(0, taskOffset - 100))}>Previous work</button><span> Page {Math.floor(taskOffset / 100) + 1} </span><button disabled={data.taskNextOffset === undefined} onClick={() => setTaskOffset(data.taskNextOffset!)}>Next work</button></div>
		</>}
	</section>;
}
