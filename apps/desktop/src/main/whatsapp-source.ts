/** Runs inside the selected connection page. Never inspect the inbox or full body.
 * Unsupported layouts and uncertain privacy controls fail closed. */
export function whatsappDomSnapshot(input: { resourceId?: string; capture: boolean }) {
 const main = document.querySelector("#main");
 if (!main && [...document.querySelectorAll("h1")].some(node => /WhatsApp works with|update.*browser/i.test(node.textContent ?? ""))) return { state: "unavailable", reason: "WhatsApp does not support this browser build. No chat content was read. Use a supported browser; Kestrel cannot sync this connection yet.", observations: [] };
 if (!main) return { state: "login_required", reason: "Link WhatsApp and open the selected group.", observations: [] };
 const name = main.querySelector("header [title]")?.getAttribute("title")?.slice(0, 300);
 const ids = [...main.querySelectorAll("[data-id]")].map(node => node.getAttribute("data-id") ?? "");
 const groups = [...new Set(ids.map(id => id.match(/(?:^|_)([0-9-]+@g\.us)(?:_|$)/)?.[1]).filter(Boolean))];
 if (!name || groups.length !== 1) return { state: "structure_changed", reason: "The selected group could not be identified reliably. Open a group with visible messages.", observations: [] };
 const resourceId = `whatsapp:group:${groups[0]}`;
 if (input.resourceId && resourceId !== input.resourceId) return { state: "unavailable", reason: "The open group differs from the assigned group.", observations: [] };
 const panels = [...document.querySelectorAll('[data-testid="drawer-right"], [aria-label="Group info"]')];
 const panel = panels.find(node => [...node.querySelectorAll("[title]")].some(item => item.getAttribute("title") === name));
 const privacyRow = panel ? [...panel.querySelectorAll('[role="button"]')].find(node => /^Advanced chat privacy\b/i.test((node.textContent ?? "").trim())) : undefined;
 const expiryRow = panel ? [...panel.querySelectorAll('[role="button"]')].find(node => /^Disappearing messages\b/i.test((node.textContent ?? "").trim())) : undefined;
 const privacyOff = privacyRow && /^Advanced chat privacy\s+Off$/i.test((privacyRow.textContent ?? "").trim());
 const expiryOff = expiryRow && /^Disappearing messages\s+Off$/i.test((expiryRow.textContent ?? "").trim());
 if (!privacyOff || !expiryOff) return { state: "privacy_blocked", name, resourceId, reason: "Open Group info. Reading requires visible, recognized Off states for Advanced chat privacy and Disappearing messages. Unknown or protected states are not captured.", observations: [] };
 if (!input.capture) return { state: "ready", name, resourceId, observations: [] };
 const rows = [...main.querySelectorAll("[data-id]")].filter(node => !node.parentElement?.closest("[data-id]"));
 if (rows.length > 200) return { state: "structure_changed", reason: "More than 200 messages are visible. Reduce the visible range before syncing.", observations: [] };
 const observations = [];
 for (const row of rows) {
  const providerMessageId = row.getAttribute("data-id") ?? "";
  if (!providerMessageId.includes(`_${groups[0]}_`)) continue;
  const content = row.querySelector("[data-pre-plain-text]");
  const originalTimestamp = content?.getAttribute("data-pre-plain-text");
  const text = [...(content?.querySelectorAll(".selectable-text") ?? [])].map(node => node.textContent ?? "").join("\n");
  if (!originalTimestamp || !text || text.length > 20_000) return { state: "structure_changed", reason: "A message could not be extracted reliably. Nothing from this capture was imported.", observations: [] };
  const senderId = providerMessageId.match(/_([0-9]+@(?:c\.us|lid))$/)?.[1];
  observations.push({ providerMessageId, originalTimestamp, text, ...(senderId ? { senderId } : {}) });
 }
 if (!observations.length) return { state: "structure_changed", reason: "No supported visible text messages were found. Media and unrecognized messages are not imported.", observations: [] };
 return { state: "ready", name, resourceId, observations };
}

/** Parse a visible timestamp only with explicit date order and IANA time zone. */
export function normalizeWhatsAppTimestamp(raw: string, dateOrder: "MDY" | "DMY", timezone: string): { occurredAt: string; senderName: string } {
 const match = raw.match(/^\[(\d{1,2}):(\d{2})(?:\s*([AP]M))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]\s*(.{1,300}):\s*$/i);
 if (!match) throw new Error("Unsupported WhatsApp timestamp format. No date was guessed.");
 let hour = Number(match[1]); const minute = Number(match[2]);
 if (match[3]) { if (hour < 1 || hour > 12) throw new Error("Invalid timestamp."); hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0); }
 const month = Number(match[dateOrder === "MDY" ? 4 : 5]); const day = Number(match[dateOrder === "MDY" ? 5 : 4]); const year = Number(match[6]);
 if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error("Invalid timestamp.");
 const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
 const wanted = Date.UTC(year, month - 1, day, hour, minute);
 const matches = new Set<number>();
 // Resolve the local wall time without assuming today's UTC offset. Reject DST ambiguity.
 for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
  const candidate = wanted + offsetMinutes * 60000;
  const parts = Object.fromEntries(formatter.formatToParts(candidate).map(item => [item.type, item.value]));
  if (Number(parts.year) === year && Number(parts.month) === month && Number(parts.day) === day && Number(parts.hour) === hour && Number(parts.minute) === minute) matches.add(candidate);
 }
 if (matches.size !== 1) throw new Error("This timestamp is ambiguous or invalid in the selected time zone.");
 return { occurredAt: new Date([...matches][0]!).toISOString(), senderName: match[7]! };
}
