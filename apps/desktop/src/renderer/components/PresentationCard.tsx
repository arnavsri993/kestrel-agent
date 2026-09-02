import {
	UIPresentationOutputSchema,
	type UIPresentation,
	type PresentationLink,
	type UIPresentationListItem,
	type RuntimeMessage,
} from "@kestrel/shared-types";
import { Fragment, useState } from "react";
import { Icon } from "./Icon";

type ToolMessage = Pick<RuntimeMessage, "content" | "toolName">;

export function parseUIPresentationMessage(
	message: ToolMessage,
): UIPresentation | undefined {
	if (message.toolName !== "ui.present") return undefined;
	try {
		const envelope = JSON.parse(message.content) as {
			status?: unknown;
			output?: unknown;
		};
		if (envelope.status !== "verified") return undefined;
		const parsed = UIPresentationOutputSchema.safeParse(envelope.output);
		return parsed.success ? parsed.data.presentation : undefined;
	} catch {
		return undefined;
	}
}

function displayStatus(value: string): string {
	return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function PresentationLinks({ links }: { links: PresentationLink[] }) {
	const [error, setError] = useState("");
	if (links.length === 0) return null;
	async function openLink(link: PresentationLink) {
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "browser-create-tab",
				input: link.url,
				active: true,
			});
			if (!response.ok)
				throw new Error("error" in response ? response.error : "Could not open link.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not open link.");
		}
	}
	return (
		<div className="presentation-links" aria-label="Presentation links">
			{links.map((link, index) => (
				<button
					className="presentation-link"
					type="button"
					key={`${link.label}-${link.url}-${index}`}
					title={link.url}
					onClick={() => void openLink(link)}
				>
					<span>{link.label}</span>
					<Icon name="arrow" />
				</button>
			))}
			{error && <small className="presentation-link-error" role="alert">{error}</small>}
		</div>
	);
}

function ListItem({ item }: { item: UIPresentationListItem }) {
	return (
		<li className="presentation-list-item">
			<div className="presentation-list-item-header">
				<strong>{item.title}</strong>
				{item.badge && <span className="presentation-badge">{item.badge}</span>}
			</div>
			{item.summary && <p>{item.summary}</p>}
			{(item.price || item.availability) && (
				<dl className="presentation-item-facts">
					{item.price && <><dt>Price</dt><dd>{item.price}</dd></>}
					{item.availability && <><dt>Availability</dt><dd>{item.availability}</dd></>}
				</dl>
			)}
			{item.details.length > 0 && (
				<ul className="presentation-item-details">
					{item.details.map((detail, index) => (
						<li key={`${detail}-${index}`}>{detail}</li>
					))}
				</ul>
			)}
			<PresentationLinks links={item.links} />
		</li>
	);
}

function Sources({ links }: { links: PresentationLink[] }) {
	if (links.length === 0) return null;
	return (
		<details className="presentation-sources">
			<summary>Sources ({links.length})</summary>
			<PresentationLinks links={links} />
		</details>
	);
}

function ListPresentation({ presentation }: { presentation: Extract<UIPresentation, { kind: "list" }> }) {
	return (
		<>
			<ul className="presentation-list">
				{presentation.items.map((item, index) => (
					<ListItem key={`${item.title}-${index}`} item={item} />
				))}
			</ul>
			<Sources links={presentation.sources} />
		</>
	);
}

function ComparisonPresentation({ presentation }: { presentation: Extract<UIPresentation, { kind: "comparison" }> }) {
	return (
		<>
			<div className="presentation-table-wrap">
				<table className="presentation-table">
					<thead>
						<tr>
							<th scope="col">Feature</th>
							{presentation.columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}
						</tr>
					</thead>
					<tbody>
						{presentation.rows.map((row, index) => (
							<tr key={`${row.label}-${index}`}>
								<th scope="row">{row.label}</th>
								{row.values.map((value, index) => <td key={`${row.label}-${index}`}>{value}</td>)}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Sources links={presentation.sources} />
		</>
	);
}

function PlanPresentation({ presentation }: { presentation: Extract<UIPresentation, { kind: "plan" }> }) {
	return (
		<>
			<ol className="presentation-plan">
				{presentation.steps.map((step, index) => (
					<li key={`${step.title}-${index}`} className={`presentation-plan-step presentation-plan-step-${step.status}`}>
						<div className="presentation-plan-step-heading">
							<strong>{step.title}</strong>
							<span>{displayStatus(step.status)}</span>
						</div>
						{step.description && <p>{step.description}</p>}
						<PresentationLinks links={step.links} />
					</li>
				))}
			</ol>
			<Sources links={presentation.sources} />
		</>
	);
}

function ResultPresentation({ presentation }: { presentation: Extract<UIPresentation, { kind: "result" }> }) {
	return (
		<>
			<div className={`presentation-result-summary presentation-result-${presentation.status}`}>
				<span>{displayStatus(presentation.status)}</span>
				<p>{presentation.summary}</p>
			</div>
			{presentation.facts.length > 0 && (
				<dl className="presentation-facts">
					{presentation.facts.map((fact, index) => (
						<Fragment key={`${fact.label}-${index}`}>
							<dt>{fact.label}</dt>
							<dd>{fact.value}</dd>
						</Fragment>
					))}
				</dl>
			)}
			<PresentationLinks links={presentation.links} />
			<Sources links={presentation.sources} />
		</>
	);
}

export function PresentationCard({ presentation }: { presentation: UIPresentation }) {
	return (
		<article className={`presentation-card presentation-card-${presentation.kind}`} aria-label={`${displayStatus(presentation.kind)} presentation`}>
			<header className="presentation-card-header">
				<div>
					<span className="presentation-eyebrow">Structured view · {displayStatus(presentation.kind)}</span>
					<h3>{presentation.title}</h3>
				</div>
				<Icon name="context" />
			</header>
			{presentation.description && <p className="presentation-description">{presentation.description}</p>}
			{presentation.kind === "list" && <ListPresentation presentation={presentation} />}
			{presentation.kind === "comparison" && <ComparisonPresentation presentation={presentation} />}
			{presentation.kind === "plan" && <PlanPresentation presentation={presentation} />}
			{presentation.kind === "result" && <ResultPresentation presentation={presentation} />}
			<footer className="presentation-card-footer">
				Local structured UI · external content is untrusted · no purchase or submission was performed by this card.
			</footer>
		</article>
	);
}
