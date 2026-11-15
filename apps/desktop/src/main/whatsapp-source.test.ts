import { expect, it } from "vitest";
import { isWhatsAppWebUrl, normalizeWhatsAppTimestamp } from "./whatsapp-source";

it("identifies WhatsApp tabs by their parsed HTTPS origin", () => {
 for (const value of [
  "https://web.whatsapp.com",
  "https://WEB.WHATSAPP.COM:443/path?query=1",
 ]) expect(isWhatsAppWebUrl(value)).toBe(true);
 for (const value of [
  "https://web.whatsapp.com.evil.test/",
  "https://web.whatsapp.com@evil.test/",
  "https://web.whatsapp.com:444/",
  "http://web.whatsapp.com/",
  "blob:https://web.whatsapp.com/id",
  "not a URL",
 ]) expect(isWhatsAppWebUrl(value)).toBe(false);
});
it("retains historical local dates using explicit order and zone", () => {
 expect(normalizeWhatsAppTimestamp("[15:30, 9/10/2026] Rishi: ", "MDY", "America/Chicago")).toEqual({ occurredAt: "2026-09-10T20:30:00.000Z", senderName: "Rishi" });
 expect(normalizeWhatsAppTimestamp("[3:30 PM, 10/9/2026] Rishi: ", "DMY", "America/Chicago").occurredAt).toBe("2026-09-10T20:30:00.000Z");
 expect(() => normalizeWhatsAppTimestamp("[1:30 AM, 11/1/2026] Rishi: ", "MDY", "America/Chicago")).toThrow("ambiguous");
 expect(() => normalizeWhatsAppTimestamp("[2:30 AM, 3/8/2026] Rishi: ", "MDY", "America/Chicago")).toThrow("ambiguous");
 expect(() => normalizeWhatsAppTimestamp("yesterday", "MDY", "America/Chicago")).toThrow("Unsupported");
});
