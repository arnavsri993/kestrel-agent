export const DIRECTORY_GROUPS = ["Browse", "Work", "Library", "Settings & help"] as const;
export type DirectoryGroup = (typeof DIRECTORY_GROUPS)[number];
export interface CommandDestination {
  id: string;
  label: string;
  detail: string;
  icon: string;
  group: DirectoryGroup;
}

export const commandDestinations: CommandDestination[] = [
	{
		id: "browser",
		label: "Browser",
		detail: "Browse the web",
		icon: "browser",
		group: "Browse",
	},
	{
		id: "organize-tabs",
		label: "Organize tabs",
		detail: "Group related tabs",
		icon: "folder",
		group: "Browse",
	},
	{
		id: "agent",
		label: "Agent",
		detail: "Start or resume work",
		icon: "agent",
		group: "Work",
	},
	{
		id: "projects",
		label: "Projects",
		detail: "Keep related work together",
		icon: "folder",
		group: "Work",
	},
	{
		id: "writing",
		label: "Writing Studio",
		detail: "Draft with your context",
		icon: "writing",
		group: "Work",
	},
	{
		id: "history",
		label: "History",
		detail: "Pages you visited",
		icon: "history",
		group: "Browse",
	},
	{
		id: "bookmarks",
		label: "Bookmarks",
		detail: "Pages you saved",
		icon: "star",
		group: "Browse",
	},
	{
		id: "downloads",
		label: "Downloads",
		detail: "Downloaded files",
		icon: "downloads",
		group: "Browse",
	},
	{
		id: "approvals",
		label: "Approvals",
		detail: "Review agent actions",
		icon: "approvals",
		group: "Work",
	},
	{
		id: "work",
		label: "Work",
		detail: "Goals, schedules, delegation, and teams",
		icon: "work",
		group: "Work",
	},
	{
		id: "events",
		label: "Opportunities",
		detail: "Track event applications",
		icon: "events",
		group: "Work",
	},
	{
		id: "connections",
		label: "Connections",
		detail: "Manage connected accounts and access",
		icon: "connections",
		group: "Settings & help",
	},
	{
		id: "memory",
		label: "Memory",
		detail: "Notes, people, and recent activity",
		icon: "memory",
		group: "Library",
	},
	{
		id: "research",
		label: "Research",
		detail: "Sources and findings",
		icon: "research",
		group: "Work",
	},
	{
		id: "artifacts",
		label: "Artifacts",
		detail: "Files and results",
		icon: "artifacts",
		group: "Library",
	},
	{
		id: "activity",
		label: "Activity",
		detail: "Runs and evidence",
		icon: "activity",
		group: "Library",
	},
	{
		id: "extensions",
		label: "Extensions",
		detail: "Plugins and tools",
		icon: "extensions",
		group: "Settings & help",
	},
	{
		id: "readiness",
		label: "Readiness",
		detail: "Check what is ready",
		icon: "readiness",
		group: "Settings & help",
	},
	{
		id: "settings",
		label: "Settings",
		detail: "Browser, agent, and privacy",
		icon: "settings",
		group: "Settings & help",
	},
	{
		id: "shortcuts",
		label: "Keyboard Shortcuts",
		detail: "Keyboard shortcuts",
		icon: "command",
		group: "Settings & help",
	},
];

export function searchDestinations(destinations: CommandDestination[], query: string): CommandDestination[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return destinations.filter(item => {
    const text = `${item.id} ${item.label} ${item.detail} ${item.group}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}
