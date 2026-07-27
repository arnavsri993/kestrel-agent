const MAX_CHAT_TITLE_LENGTH = 60;

const REQUEST_PREFIXES = [
  /^(?:hey|hi|hello)[,!:.\s-]+/i,
  /^(?:can|could|would|will)\s+you\s+/i,
  /^(?:please|kindly)\s+/i,
  /^(?:i\s+(?:want|need)\s+you\s+to)\s+/i,
  /^(?:help\s+me\s+(?:to\s+)?)\s*/i,
  /^(?:make\s+it\s+so\s+that\s+|make\s+it\s+so\s+)/i,
];

function withoutRequestPrefix(value: string): string {
  let result = value;
  let previous = "";
  while (result !== previous) {
    previous = result;
    for (const prefix of REQUEST_PREFIXES) result = result.replace(prefix, "");
  }
  return result;
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, limit + 1);
  const boundary = candidate.lastIndexOf(" ");
  return (boundary >= Math.floor(limit * 0.6)
    ? candidate.slice(0, boundary)
    : value.slice(0, limit)
  ).trimEnd();
}

export function chatTitleFromPrompt(prompt: string): string {
  const firstMeaningfulLine =
    prompt
      .replace(/```[\s\S]*?```/g, " ")
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
          .replace(/!\[[^\]]*]\([^)]*\)/g, "")
          .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
          .replace(/[*_~`#>]/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";

  const cleaned = withoutRequestPrefix(firstMeaningfulLine)
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:\s-]+$/g, "")
    .trim();

  if (!cleaned) return "New chat";

  const concise = truncateAtWord(cleaned, MAX_CHAT_TITLE_LENGTH);
  return concise.charAt(0).toUpperCase() + concise.slice(1);
}

export function sessionTitleForDisplay(title: string): string {
  // The setup coach session predates the visible Kestrel rename. Keep stored
  // history intact while preventing old product chrome from leaking into the
  // current shell.
  return title.startsWith("Help me finish setting up Workstrand")
    ? title.replaceAll("Workstrand", "Kestrel")
    : title;
}
