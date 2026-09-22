import { useEffect, useMemo, useRef, useState } from "react";
import { DIRECTORY_GROUPS, searchDestinations, type CommandDestination, type DirectoryGroup } from "../../app-directory";
import { Icon } from "../Icon";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { PageFrame } from "../ui";
import "./surface-pages.css";

export function CommandCenter({ destinations, onSelect, onClose, onBack, onNewTask, pendingApprovals = 0 }: {
  destinations: CommandDestination[];
  onSelect(destination: string): void;
  onClose(): void;
  onBack?(): void;
  onNewTask?(): void;
  pendingApprovals?: number;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<DirectoryGroup | "All">("All");
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = Boolean(query.trim());
  const visible = useMemo(() => searchDestinations(destinations, query).filter(
    item => searching || category === "All" || item.group === category,
  ), [destinations, query, searching, category]);

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
    <PageFrame as="main" className="command-center" title="Command Center"
      description="Find a place to work, your saved context, or a setting."
      titleId="command-center-title" measure="standard"
      actions={onBack ? <SurfaceBackButton onBack={onBack} /> : undefined}>
      <div className="command-search">
        <Icon name="search" />
        <label className="sr-only" htmlFor="kestrel-directory-search">Search Kestrel</label>
        <input id="kestrel-directory-search" ref={searchRef} autoFocus value={query}
          placeholder="Search pages, tools, and settings"
          onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" className="directory-clear" onClick={() => {
          setQuery(""); searchRef.current?.focus();
        }}>Clear</button> : <kbd>⌘ K</kbd>}
      </div>
      <div className="directory-controls">
        {!searching ? <div className="workspace-sections" role="group" aria-label="Explore categories">
          {(["All", ...DIRECTORY_GROUPS] as const).map(group => <button type="button" key={group}
            aria-pressed={category === group} onClick={() => setCategory(group)}>{group}</button>)}
        </div> : <p className="directory-result-count" role="status">{visible.length} {visible.length === 1 ? "destination" : "destinations"} across all sections</p>}
        {!searching && category === "All" && (onNewTask || pendingApprovals > 0) ?
          <div className="directory-quick-actions">
            {onNewTask ? <button type="button" className="button secondary" onClick={onNewTask}><Icon name="plus" />New chat</button> : null}
            {pendingApprovals > 0 ? <button type="button" className="button secondary" onClick={() => onSelect("approvals")}>
              <Icon name="approvals" />Review {pendingApprovals} pending {pendingApprovals === 1 ? "approval" : "approvals"}
            </button> : null}
          </div> : null}
      </div>
      {visible.length === 0 ? <div className="command-empty" role="status">
        <p>No matches for &ldquo;{query.trim()}&rdquo;.</p>
        <button type="button" className="button secondary" onClick={() => {
          setQuery(""); setCategory("All"); searchRef.current?.focus();
        }}>Show all destinations</button>
      </div> : <div className="command-groups">
        {DIRECTORY_GROUPS.map((group, index) => {
          const items = visible.filter(item => item.group === group);
          if (!items.length) return null;
          return <section key={group} aria-labelledby={`directory-group-${index}`}>
            <h2 id={`directory-group-${index}`}>{group}</h2>
            <div>{items.map(destination => <button type="button" key={destination.id} onClick={() => onSelect(destination.id)}>
              <Icon name={destination.icon} /><span><strong>{destination.label}</strong><small>{destination.detail}</small></span><Icon name="chevron" />
            </button>)}</div>
          </section>;
        })}
      </div>}
    </PageFrame>
  );
}
