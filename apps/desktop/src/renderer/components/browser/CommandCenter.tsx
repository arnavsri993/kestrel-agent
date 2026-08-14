import { useEffect, useMemo, useState } from "react";
import { Icon } from "../Icon";

export interface CommandDestination {
	id: string;
	label: string;
	detail: string;
	icon: string;
	group: "Browse" | "Agent" | "Context" | "Build" | "System";
}

export function CommandCenter({
	destinations,
	onSelect,
	onClose,
}: {
	destinations: CommandDestination[];
	onSelect(destination: string): void;
	onClose(): void;
}) {
	const [query, setQuery] = useState("");
	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return destinations.filter(
			(destination) =>
				!needle ||
				`${destination.label} ${destination.detail} ${destination.group}`
					.toLowerCase()
					.includes(needle),
		);
	}, [destinations, query]);
	useEffect(() => {
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [onClose]);

	return (
		<main className="command-center" aria-labelledby="command-center-title">
			<header>
				<span className="command-mark">
					<Icon name="command" />
				</span>
				<div>
					<h1 id="command-center-title">Capabilities</h1>
				</div>
			</header>
			<label className="command-search">
				<Icon name="search" />
				<span className="sr-only">Search Kestrel</span>
				<input
					autoFocus
					value={query}
					placeholder="Search actions and settings"
					onChange={(event) => setQuery(event.target.value)}
				/>
				<kbd>⌘ K</kbd>
			</label>
			{visible.length === 0 ? (
				<p className="command-empty">No matching destination.</p>
			) : (
				<div className="command-groups">
					{(["Browse", "Agent", "Context", "Build", "System"] as const).map(
						(group) => {
							const items = visible.filter(
								(destination) => destination.group === group,
							);
							if (!items.length) return null;
							return (
								<section key={group} aria-labelledby={`command-${group}`}>
									<h2 id={`command-${group}`}>{group}</h2>
									<div>
										{items.map((destination) => (
											<button
												type="button"
												key={destination.id}
												onClick={() => onSelect(destination.id)}
											>
												<Icon name={destination.icon} />
												<span>
													<strong>{destination.label}</strong>
													<small>{destination.detail}</small>
												</span>
												<Icon name="chevron" />
											</button>
										))}
									</div>
								</section>
							);
						},
					)}
				</div>
			)}
		</main>
	);
}
