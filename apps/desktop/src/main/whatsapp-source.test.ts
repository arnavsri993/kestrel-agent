import { expect, it } from "vitest";
import { isWhatsAppWebUrl, normalizeWhatsAppTimestamp } from "./whatsapp-source";
it("retains historical local dates using explicit order and zone", () => {
 expect(normalizeWhatsAppTimestamp("[15:30, 9/10/2026] Rishi: ", "MDY", "America/Chicago")).toEqual({ occurredAt: "2026-09-10T20:30:00.000Z", senderName: "Rishi" });
 expect(normalizeWhatsAppTimestamp("[3:30 PM, 10/9/2026] Rishi: ", "DMY", "America/Chicago").occurredAt).toBe("2026-09-10T20:30:00.000Z");
 expect(() => normalizeWhatsAppTimestamp("[1:30 AM, 11/1/2026] Rishi: ", "MDY", "America/Chicago")).toThrow("ambiguous");
 expect(() => normalizeWhatsAppTimestamp("[2:30 AM, 3/8/2026] Rishi: ", "MDY", "America/Chicago")).toThrow("ambiguous");
 expect(() => normalizeWhatsAppTimestamp("yesterday", "MDY", "America/Chicago")).toThrow("Unsupported");
});


it.each([
 ["https://web.whatsapp.com", true],
 ["https://WEB.WHATSAPP.COM:443/?test=1#chat", true],
 ["https://web.whatsapp.com/path", true],
 ["https://web.whatsapp.com.evil.invalid", false],
 ["https://web.whatsapp.com@evil.invalid", false],
 ["https://web.whatsapp.com:444", false],
 ["http://web.whatsapp.com", false],
 ["about:blank", false],
 ["invalid URL", false],
])("recognizes the exact WhatsApp origin for %s", (url, expected) => {
 expect(isWhatsAppWebUrl(url)).toBe(expected);
});
