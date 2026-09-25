import type { Project, ProviderAccountSummary, RuntimeApprovalPolicy, SelectedAttachment } from "@kestrel/shared-types";
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { Icon } from "../Icon";
import { ModelSelector } from "./ModelSelector";
import { createPastedTextAttachment, LARGE_PASTE_MIN_LENGTH, removePastedTextAttachment } from "./composer-paste";
import { accountForChoice, type ModelSelectorChoice } from "./model-selector";
import type { NewTabComposerDraft } from "./new-tab-composer";
import "./new-tab-composer.css";

function savedModelChoice(): ModelSelectorChoice {
	const effort = localStorage.getItem("kestrel:reasoning-effort");
	const accountId = localStorage.getItem("kestrel:provider-account-id");
	return {
		executionMode: localStorage.getItem("kestrel:execution-mode") === "manual" ? "manual" : "automatic",
		providerId: localStorage.getItem("kestrel:provider-id") ?? "",
		...(accountId ? { accountId } : {}),
		model: localStorage.getItem("kestrel:model") ?? "",
		reasoningEffort: effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" || effort === "none" ? effort : "none",
	};
}

export function NewTabComposer({ agentName, projects, onProjectsChange, onNavigate, onSubmitDraft }: {
	agentName: string;
	projects: Project[];
	onProjectsChange(projects: Project[]): void;
	onNavigate(input: string): void;
	onSubmitDraft(draft: NewTabComposerDraft): boolean;
}) {
	const [input, setInput] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [accessOpen, setAccessOpen] = useState(false);
	const [approvalPolicy, setApprovalPolicy] = useState<RuntimeApprovalPolicy>(() => {
		const saved = localStorage.getItem("kestrel:approval-policy");
		return saved === "ask" || saved === "full_access" ? saved : "auto";
	});
	const [workspaceRoot, setWorkspaceRoot] = useState("");
	const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
	const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([]);
	const [choice, setChoice] = useState(savedModelChoice);
	const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const voiceTimeoutRef = useRef<number | null>(null);
	const aliveRef = useRef(true);
	const accessRef = useRef<HTMLDivElement>(null);
	const availableProjects = projects.filter((project) => project.available !== false);
	const selectedProject = availableProjects.find((project) => project.path === workspaceRoot);
	const canSend = Boolean(input.trim() || attachments.length);
	const approvalLabel = approvalPolicy === "ask" ? "Ask for approval" : approvalPolicy === "full_access" ? "Full access" : "Approve for me";

	useEffect(() => {
		let active = true;
		void window.kestrel.request({ type: "runtime-list-providers" }).then((response) => {
			if (active && response.ok && "providerAccounts" in response) setAccounts(response.providerAccounts ?? []);
		}).catch(() => undefined);
		return () => { active = false; };
	}, []);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
		aliveRef.current = false;
		if (voiceTimeoutRef.current !== null) window.clearTimeout(voiceTimeoutRef.current);
		if (recorderRef.current) recorderRef.current.onstop = null;
		if (recorderRef.current?.state === "recording") recorderRef.current.stop();
		streamRef.current?.getTracks().forEach((track) => track.stop());
		};
	}, []);
	useEffect(() => {
		const prompt = inputRef.current;
		if (!prompt || !expanded) return;
		prompt.style.height = "auto";
		prompt.style.height = `${Math.min(Math.max(prompt.scrollHeight, 55), 180)}px`;
		prompt.style.overflowY = prompt.scrollHeight > 180 ? "auto" : "hidden";
	}, [expanded, input]);
	useEffect(() => {
		if (!accessOpen) return;
		accessRef.current?.querySelector<HTMLButtonElement>("[role=menu] button")?.focus();
		function closeOnOutside(event: PointerEvent) {
			if (!accessRef.current?.contains(event.target as Node)) setAccessOpen(false);
		}
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") { setAccessOpen(false); accessRef.current?.querySelector<HTMLButtonElement>(".new-tab-access-trigger")?.focus(); }
		}
		window.addEventListener("pointerdown", closeOnOutside);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", closeOnOutside);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [accessOpen]);

	function applyChoice(next: ModelSelectorChoice) {
		setChoice(next);
		localStorage.setItem("kestrel:execution-mode", next.executionMode);
		if (next.providerId) localStorage.setItem("kestrel:provider-id", next.providerId);
		if (next.accountId) localStorage.setItem("kestrel:provider-account-id", next.accountId);
		else localStorage.removeItem("kestrel:provider-account-id");
		if (next.model.trim()) localStorage.setItem("kestrel:model", next.model.trim());
		localStorage.setItem("kestrel:reasoning-effort", next.reasoningEffort);
	}

	function applyApprovalPolicy(next: RuntimeApprovalPolicy) {
		setApprovalPolicy(next);
		localStorage.setItem("kestrel:approval-policy", next);
		setAccessOpen(false);
	}

	async function chooseProject(): Promise<string | undefined> {
		setAccessOpen(false);
		try {
			const response = await window.kestrel.request({ type: "select-workspace-folder" });
			if (!response.ok) throw new Error(response.error);
			if ("projects" in response && response.projects) onProjectsChange(response.projects);
			if ("selectedWorkspacePath" in response && response.selectedWorkspacePath) {
				setWorkspaceRoot(response.selectedWorkspacePath);
				return response.selectedWorkspacePath;
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not choose a project.");
		}
		return undefined;
	}

	async function addFiles() {
		const selectedRoot = workspaceRoot || await chooseProject();
		if (!selectedRoot) return;
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({ type: "select-context-files", workspaceRoot: selectedRoot });
			if (!response.ok) throw new Error(response.error);
			if ("selectedAttachments" in response) setAttachments((current) => {
				const byPath = new Map([...current, ...response.selectedAttachments].map((attachment) => [attachment.path, attachment]));
				return [...byPath.values()].slice(0, 8);
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not add files.");
		} finally { setBusy(false); }
	}

	async function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		const text = event.clipboardData.getData("text/plain");
		if (text.length < LARGE_PASTE_MIN_LENGTH) return;
		event.preventDefault();
		if (attachments.length >= 8) { setError("Remove an attachment before pasting more text."); return; }
		setBusy(true);
		setError("");
		try {
			const attachment = await createPastedTextAttachment(text);
			setAttachments((current) => [...current, attachment].slice(0, 8));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not attach pasted text.");
		} finally { setBusy(false); }
	}

	function send(event?: FormEvent) {
		event?.preventDefault();
		if (busy || voiceState !== "idle" || !canSend) return;
		const prompt = input.trim() || "Review the attached file.";
		if (choice.executionMode === "manual" && (!choice.model.trim() || !accountForChoice(accounts, choice))) {
			setError("Choose an available model account or switch to Auto.");
			return;
		}
		if (!attachments.length && !workspaceRoot && /^\S+$/.test(prompt) && /^(https?:\/\/|localhost(:\d+)?(\/|$)|[\w-]+\.[\w.-]+)/i.test(prompt)) {
			onNavigate(prompt);
			setInput("");
			return;
		}
		const accepted = onSubmitDraft({ prompt, ...(workspaceRoot ? { workspaceRoot } : {}), ...(selectedProject ? { projectId: selectedProject.id } : {}), modelChoice: choice, approvalPolicy, attachments });
		if (!accepted) {
			setError("Finish or stop the active task before starting this one.");
			return;
		}
		setInput("");
		setAttachments([]);
	}

	async function startVoice() {
		if (voiceState !== "idle" || busy) return;
		setError("");
		try {
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Voice capture is unavailable on this device.");
			const permission = await window.kestrel.request({ type: "request-microphone-access" });
			if (!permission.ok || !("microphoneAccess" in permission) || !permission.microphoneAccess) throw new Error("Microphone access was not granted.");
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
			streamRef.current = stream;
			const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((kind) => MediaRecorder.isTypeSupported(kind));
			const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
			recorder.onerror = () => { setError("Voice recording failed."); setVoiceState("idle"); stream.getTracks().forEach((track) => track.stop()); };
				recorder.onstop = () => {
				if (voiceTimeoutRef.current !== null) window.clearTimeout(voiceTimeoutRef.current);
				voiceTimeoutRef.current = null;
				stream.getTracks().forEach((track) => track.stop());
				streamRef.current = null;
				recorderRef.current = null;
				if (!aliveRef.current) return;
				const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
				if (!blob.size || blob.size > 25 * 1024 * 1024) { setError("Voice recording is empty or exceeds 25 MB."); setVoiceState("idle"); return; }
				setVoiceState("transcribing");
				const reader = new FileReader();
				reader.onerror = () => { if (aliveRef.current) { setError("Could not read the recording."); setVoiceState("idle"); } };
				reader.onload = () => {
					if (!aliveRef.current) return;
					const dataBase64 = String(reader.result).split(",")[1] ?? "";
					void window.kestrel.request({ type: "media-transcribe", dataBase64, mediaType: blob.type.split(";")[0] || "audio/webm" }).then((response) => {
						if (!response.ok) throw new Error(response.error);
						if (!("transcription" in response) || !response.transcription) throw new Error("Transcription returned no text.");
						if (!aliveRef.current) return;
						setInput((current) => current ? `${current.trimEnd()} ${response.transcription!.text}` : response.transcription!.text);
						setExpanded(true);
						inputRef.current?.focus();
					}).catch((cause) => { if (aliveRef.current) setError(cause instanceof Error ? cause.message : "Voice transcription failed."); }).finally(() => { if (aliveRef.current) setVoiceState("idle"); });
				};
				reader.readAsDataURL(blob);
			};
			recorderRef.current = recorder;
			recorder.start(1_000);
			voiceTimeoutRef.current = window.setTimeout(() => {
				if (recorder.state === "recording") recorder.stop();
			}, 120_000);
			setVoiceState("recording");
		} catch (cause) {
			streamRef.current?.getTracks().forEach((track) => track.stop());
			setVoiceState("idle");
			setError(cause instanceof Error ? cause.message : "Could not start voice capture.");
		}
	}

	const isExpanded = expanded || Boolean(input) || attachments.length > 0;
	return <div className={`kestrel-home-composer kestrel-task-composer${isExpanded ? " is-expanded" : ""}`} onFocus={() => setExpanded(true)}>
		<form onSubmit={send}>
			<label className="sr-only" htmlFor="new-tab-chat-input">Message {agentName} or enter a URL</label>
			<textarea ref={inputRef} id="new-tab-chat-input" rows={1} value={input} placeholder={`Ask ${agentName} or enter a URL`} onChange={(event) => setInput(event.target.value)} onPaste={(event) => void onPaste(event)} onKeyDown={(event) => {
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
			}} />
			{attachments.length > 0 && <div className="new-tab-composer-attachments" aria-label="Attached files">{attachments.map((attachment) => <button type="button" key={attachment.path} aria-label={`Remove ${attachment.name}`} onClick={() => { removePastedTextAttachment(attachment); setAttachments((current) => current.filter((item) => item.path !== attachment.path)); }}><Icon name="file" /><span>{attachment.name}</span><Icon name="close" /></button>)}</div>}
			<div className="new-tab-composer-footer" inert={isExpanded ? undefined : true} aria-hidden={!isExpanded}>
				<div className="new-tab-composer-actions">
					<button type="button" className="new-tab-composer-icon" aria-label="Add files" title={workspaceRoot ? "Add files from this project" : "Choose a project to add files"} disabled={busy} onClick={() => void addFiles()}><Icon name="plus" /></button>
					<div className={`new-tab-access${approvalPolicy === "full_access" ? " is-full-access" : ""}`} ref={accessRef}>
						<button type="button" className="new-tab-access-trigger" aria-haspopup="menu" aria-expanded={accessOpen} aria-label={`Approval policy: ${approvalLabel}`} onClick={() => setAccessOpen((current) => !current)}><Icon name={approvalPolicy === "full_access" ? "shield" : "lock"} /><span>{approvalLabel}</span><Icon name="chevron" /></button>
						{accessOpen && <div className="new-tab-access-menu" role="menu" aria-label="Approval policy" onKeyDown={(event) => {
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                            event.preventDefault();
                            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
                            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                            buttons[next]?.focus();
						}}><div className="new-tab-access-heading">How should Kestrel actions be approved?</div><button type="button" role="menuitemradio" aria-checked={approvalPolicy === "ask"} onClick={() => applyApprovalPolicy("ask")}>Ask for approval<small>Ask before every action that changes data</small></button><button type="button" role="menuitemradio" aria-checked={approvalPolicy === "auto"} onClick={() => applyApprovalPolicy("auto")}>Approve for me<small>Only ask for sensitive or external actions</small></button><button type="button" className="new-tab-access-full" role="menuitemradio" aria-checked={approvalPolicy === "full_access"} onClick={() => applyApprovalPolicy("full_access")}>Full access<small>Skip routine prompts; hard safety boundaries still apply</small></button></div>}
					</div>
				</div>
				<div className="new-tab-composer-send-actions"><ModelSelector accounts={accounts} choice={choice} onChange={applyChoice} /><button type="button" className={`new-tab-composer-icon${voiceState === "recording" ? " is-recording" : ""}`} aria-label={voiceState === "recording" ? "Stop and transcribe voice" : "Record voice"} title={voiceState === "recording" ? "Stop and transcribe voice" : "Record voice"} disabled={busy || voiceState === "transcribing"} onClick={() => voiceState === "recording" ? recorderRef.current?.stop() : void startVoice()}><Icon name="voice" /></button><button type="submit" className="kestrel-home-send" aria-label={`Send message to ${agentName}`} title={`Send message to ${agentName}`} disabled={!canSend || busy || voiceState !== "idle"}><Icon name="arrow" /></button></div>
			</div>
		</form>
		{voiceState !== "idle" && <span className="new-tab-composer-status" role="status">{voiceState === "recording" ? "Microphone live · tap to transcribe" : "Transcribing voice…"}</span>}
		{error && <p className="new-tab-composer-error" role="alert">{error}</p>}
	</div>;
}
