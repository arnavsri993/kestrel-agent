import type { SVGProps } from "react";

const paths: Record<string, string[]> = {
  plus: ["M12 5v14M5 12h14"],
  chevron: ["M9 6l6 6-6 6"],
  today: ["M4 5.5h16M7 3v5M17 3v5M5 8.5h14v11H5z", "M8 12h3M13 12h3M8 16h3"],
  chat: ["M4 5h16v11H9l-5 4z", "M8 9h8M8 13h5"],
  readiness: ["M12 3a9 9 0 109 9", "M12 7v5l3 2", "M16.5 5.5l1.4 1.4L21 3.8"],
  approvals: ["M12 3l8 4v5c0 4.8-3.2 7.7-8 9-4.8-1.3-8-4.2-8-9V7z", "M8.5 12l2.2 2.2L16 9"],
  memory: ["M6 5.5C6 4.1 8.7 3 12 3s6 1.1 6 2.5S15.3 8 12 8 6 6.9 6 5.5z", "M6 5.5v6C6 12.9 8.7 14 12 14s6-1.1 6-2.5v-6M6 11.5v6C6 18.9 8.7 20 12 20s6-1.1 6-2.5v-6"],
  activity: ["M5 18V9M12 18V4M19 18v-6", "M3 21h18"],
  connections: ["M9 8a4 4 0 015.7 0l1.3-1.3a4 4 0 015.7 5.7L18 16", "M15 16a4 4 0 01-5.7 0L8 14.7A4 4 0 012.3 9L6 5.3"],
  settings: ["M12 9a3 3 0 100 6 3 3 0 000-6z", "M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21h-4v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3v-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 001.9.3 1.7 1.7 0 001-1.5V3h4v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.5 1h.1v4h-.1a1.7 1.7 0 00-1.5 1z"],
  search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
  research: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
  work: ["M5 6h14v13H5z", "M9 6V4h6v2M8 11h8M8 15h5"],
  artifacts: ["M4 5h6l2 2h8v12H4z", "M8 12l2-2 3 4 2-2 3 4H7z"],
  arrow: ["M5 12h14", "M14 7l5 5-5 5"],
  check: ["M5 12l4 4L19 6"],
  pause: ["M8 5v14M16 5v14"],
  voice: ["M5 10v4M9 7v10M13 5v14M17 8v8M21 10v4"]
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {(paths[name] ?? paths.arrow)!.map((path) => <path d={path} key={path} />)}
  </svg>;
}
