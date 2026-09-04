import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type FormEvent,
} from "react";
import type { Project } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
	DEFAULT_PROJECT_APPEARANCE,
	PROJECT_COLOR_OPTIONS,
	PROJECT_ICON_OPTIONS,
	projectColorValue,
	type ProjectAppearance,
	type ProjectColor,
	type ProjectIcon,
} from "../../project-appearance";

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ProjectSettingsDialog({
	project,
	appearance = DEFAULT_PROJECT_APPEARANCE,
	onClose,
	onSave,
	onDelete,
}: {
	project: Project;
	appearance?: ProjectAppearance;
	onClose(): void;
	onSave(input: {
		name: string;
		instructions: string;
		appearance: ProjectAppearance;
	}): Promise<void>;
	onDelete(): Promise<void>;
}) {
	const dialogRef = useRef<HTMLDivElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(project.name);
	const [instructions, setInstructions] = useState(project.instructions ?? "");
	const [selectedAppearance, setSelectedAppearance] = useState(appearance);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusable = [
				...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
			];
			if (focusable.length === 0) return;
			const first = focusable[0]!;
			const last = focusable.at(-1)!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await onSave({
				name,
				instructions,
				appearance: selectedAppearance,
			});
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save project settings.");
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (busy) return;
		const confirmed = window.confirm(
			`Delete ${project.name}? Its conversations will stay in Chats.`,
		);
		if (!confirmed) return;
		setBusy(true);
		setError("");
		try {
			await onDelete();
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not delete project.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="kestrel-project-settings-overlay" role="presentation" onMouseDown={(event) => {
			if (event.target === event.currentTarget && !busy) onClose();
		}}>
			<div
				ref={dialogRef}
				className="kestrel-project-settings-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="kestrel-project-settings-title"
				aria-describedby="kestrel-project-settings-description"
			>
				<header className="kestrel-project-settings-header">
					<div className="kestrel-project-settings-heading">
						<span className="kestrel-project-settings-mark" aria-hidden="true">
							<Icon name={selectedAppearance.icon} />
						</span>
						<div>
							<strong id="kestrel-project-settings-title">Project settings</strong>
							<p id="kestrel-project-settings-description">Name and context for chats in {project.name}.</p>
						</div>
					</div>
					<button type="button" className="kestrel-project-settings-close" aria-label="Close project settings" onClick={onClose} disabled={busy}>
						<Icon name="close" />
					</button>
				</header>

				<form onSubmit={save}>
					<label className="kestrel-project-settings-field">
						<span>Project name</span>
						<input ref={nameRef} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
					</label>
					<label className="kestrel-project-settings-field">
						<span>Instructions <small>optional</small></span>
						<textarea
							value={instructions}
							maxLength={20_000}
							rows={5}
							placeholder="Add context that every chat in this project should follow."
							onChange={(event) => setInstructions(event.target.value)}
						/>
					</label>

					<fieldset className="kestrel-project-settings-fieldset">
						<legend>Appearance</legend>
						<div className="kestrel-project-settings-icons" role="group" aria-label="Project icon">
							{PROJECT_ICON_OPTIONS.map((option) => (
								<button
									type="button"
									key={option.id}
									className={selectedAppearance.icon === option.id ? "selected" : ""}
									aria-label={option.label}
									aria-pressed={selectedAppearance.icon === option.id}
									onClick={() => setSelectedAppearance((current) => ({ ...current, icon: option.id as ProjectIcon }))}
								>
									<Icon name={option.id} />
								</button>
							))}
						</div>
						<div className="kestrel-project-settings-colors" role="group" aria-label="Project color">
							{PROJECT_COLOR_OPTIONS.map((option) => (
								<button
									type="button"
									key={option.id}
									className={selectedAppearance.color === option.id ? "selected" : ""}
									style={{ "--project-color": projectColorValue(option.id) } as CSSProperties}
									aria-label={option.label}
									aria-pressed={selectedAppearance.color === option.id}
									onClick={() => setSelectedAppearance((current) => ({ ...current, color: option.id as ProjectColor }))}
								>
									<span aria-hidden="true" />
								</button>
							))}
						</div>
					</fieldset>

					{error ? <p className="kestrel-project-settings-error" role="alert">{error}</p> : null}
					<footer className="kestrel-project-settings-footer">
						<button type="button" className="kestrel-project-settings-delete" onClick={() => void remove()} disabled={busy}>Delete project</button>
						<span />
						<button type="button" className="kestrel-project-settings-cancel" onClick={onClose} disabled={busy}>Cancel</button>
						<button type="submit" className="kestrel-project-settings-save" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save changes"}</button>
					</footer>
				</form>
			</div>
		</div>
	);
}
