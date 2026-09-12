// Dedicated isolated world; page scripts cannot alter the field registry or built-ins.
export const PAYMENT_AUTOFILL_WORLD_ID = 1004;

// Shared by all three scripts so save and fill cannot disagree about a CVV.
const PAYMENT_FIELD_HELPERS = String.raw`
  const token = (node) => String(node.autocomplete || "").toLowerCase().trim().split(/\s+/).at(-1) || "";
  const section = (node) => String(node.autocomplete || "").toLowerCase().split(/\s+/).filter(value => value.startsWith("section-") || value === "shipping" || value === "billing").join(" ");
  const owner = (node) => node.form || node.closest('[role="form"]') || document;
  const visible = (node) => {
    if (!node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || parent.hasAttribute("inert")) return false;
    }
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  };
  const registry = globalThis.__kestrelPaymentFieldRegistry ??= { ids: new WeakMap(), next: crypto.getRandomValues(new Uint32Array(1))[0] * 1000000 };
  const fieldId = (node) => {
    const signature = [node.type,node.autocomplete,node.name,node.id,node.placeholder,node.getAttribute("aria-label"),node.labels?.[0]?.innerText].join("\0");
    let field = registry.ids.get(node);
    if (!field || field.signature !== signature || field.owner !== owner(node)) {
      field = { id: "payment-field-" + registry.next++, signature, owner: owner(node) };
      registry.ids.set(node, field);
    }
    return field.id;
  };
  const paymentKind = (node) => {
    const type = String(node.type || "").toLowerCase();
    if (node.matches(":disabled") || node.readOnly || ["hidden","file","checkbox","radio","button","submit","reset","image","range","color"].includes(type)) return null;
    const autocomplete = token(node);
    const hint = [node.name,node.id,node.placeholder,node.getAttribute("aria-label"),node.labels?.[0]?.innerText].filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g,"$1 $2").replace(/[_-]+/g," ").toLowerCase();
    if (["cc-csc","cc-cvv","one-time-code"].includes(autocomplete) || /(?:security|verification|\bcvv\b|\bcvc\b|\bcsc\b|card[-_ ]?code)/i.test(hint)) return "security-code";
    if (type === "password" || /password|passcode|\botp\b|api[-_ ]?key|access[-_ ]?token|private[-_ ]?key/i.test(hint)) return null;
    const explicit = {"cc-number":"card-number","cc-exp-month":"expiration-month","cc-exp-year":"expiration-year","cc-exp":"expiration","cc-name":"cardholder-name","postal-code":"postal-code"};
    if (explicit[autocomplete]) return explicit[autocomplete];
    if (autocomplete && autocomplete !== "on") return null;
    if (/(?:\b(?:cc|card)[-_ ]?(?:number|no)\b|\bcardnumber\b|\bpan\b)/i.test(hint)) return "card-number";
    if (/(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*month|month.*(?:exp|expiry|expiration)/i.test(hint)) return "expiration-month";
    if (/(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)).*year|year.*(?:exp|expiry|expiration)/i.test(hint)) return "expiration-year";
    if (/(?:cc[-_ ]?exp|card[-_ ]?(?:exp|expiry|expiration)|expir(?:y|ation))/i.test(hint)) return "expiration";
    if (/(?:cardholder|card[-_ ]?name|name[-_ ]?on[-_ ]?card)/i.test(hint)) return "cardholder-name";
    if (/(?:billing[-_ ]?)?(?:postal|post[-_ ]?code|zip)/i.test(hint)) return "postal-code";
    return null;
  };
`;

export const PAYMENT_FORM_SCAN_SCRIPT = String.raw`(() => {
  ${PAYMENT_FIELD_HELPERS}
  const describe = (node) => {
    const type = String(node.type || node.tagName || "").toLowerCase();
    const autocomplete = token(node);
    const kind = paymentKind(node);
    if (!kind) return null;
    const rect = node.getBoundingClientRect();
    const label = String(
      node.labels?.[0]?.innerText || node.getAttribute("aria-label") ||
      node.placeholder || node.name || kind
    ).replace(/\s+/g, " ").trim().slice(0, 500);
    return {
      kind,
      label,
      type: type.slice(0, 100),
      autocomplete: autocomplete.slice(0, 100),
      rect: {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      },
      node,
    };
  };
  const rawFields = Array.from(document.querySelectorAll("input,select,textarea"))
    .filter(visible)
    .map(describe)
    .filter(Boolean)
    .slice(0, 32)
    .map((field) => ({ id: fieldId(field.node), ...field }));
  const anchor = rawFields.find(field => field.node === document.activeElement) || rawFields.find(field => field.kind === "card-number");
  const selectedFields = anchor ? rawFields.filter(field => owner(field.node) === owner(anchor.node) && section(field.node) === section(anchor.node)) : [];
  const numberField = selectedFields.find((field) => field.kind === "card-number");
  if (!numberField) return { fields: [] };
  const valueOf = (field) => String(field?.node?.value || "").trim();
  const cardDigits = valueOf(numberField).replace(/\D/g, "");
  const brand = (digits) => {
    if (/^4/.test(digits)) return "Visa";
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d))/.test(digits)) return "Mastercard";
    if (/^3[47]/.test(digits)) return "American Express";
    if (/^(6011|65|64[4-9])/.test(digits)) return "Discover";
    if (/^(35|2131|1800)/.test(digits)) return "JCB";
    if (/^3(?:0[0-5]|[68])/.test(digits)) return "Diners Club";
    return "Card";
  };
  const expirationField = selectedFields.find((field) => field.kind === "expiration");
  const monthField = selectedFields.find((field) => field.kind === "expiration-month");
  const yearField = selectedFields.find((field) => field.kind === "expiration-year");
  const normalizeMonth = (value) => {
    const digits = value.replace(/\D/g, "");
    return digits.length === 1 ? digits.padStart(2, "0") : digits.slice(-2);
  };
  const normalizeYear = (value) => value.replace(/\D/g, "").slice(-2);
  const expirationValue = valueOf(expirationField);
  let month = normalizeMonth(valueOf(monthField));
  let year = normalizeYear(valueOf(yearField));
  if ((!month || !year) && /^\d{4}-\d{2}$/.test(expirationValue)) {
    month ||= expirationValue.slice(5, 7);
    year ||= expirationValue.slice(2, 4);
  }
  if (!month || !year) {
    const combinedDigits = expirationValue.replace(/\D/g, "");
    if (combinedDigits.length === 3) {
      month ||= normalizeMonth(combinedDigits.slice(0, 1));
      year ||= combinedDigits.slice(-2);
    } else if (combinedDigits.length >= 4) {
      month ||= normalizeMonth(combinedDigits.slice(0, 2));
      year ||= combinedDigits.slice(-2);
    }
  }
  const passesLuhn = (digits) => {
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  };
  const active = document.activeElement;
  const focusedFieldId = rawFields.find((field) => field.node === active)?.id;
  const candidate = cardDigits.length >= 12 && cardDigits.length <= 19 &&
    passesLuhn(cardDigits) && /^(0[1-9]|1[0-2])$/.test(month) && /^\d{2}$/.test(year) ? {
    brand: brand(cardDigits),
    last4: cardDigits.slice(-4),
    ...(month && /^(0[1-9]|1[0-2])$/.test(month) ? { expirationMonth: month } : {}),
    ...(year && /^\d{2}$/.test(year) ? { expirationYear: year } : {}),
  } : undefined;
  return {
    fields: selectedFields.map(({ node, ...field }) => field),
    ...(focusedFieldId ? { focusedFieldId } : {}),
    ...(candidate ? { candidate } : {}),
  };
})()`;

export const PAYMENT_FORM_VALUES_SCRIPT = String.raw`(() => {
  ${PAYMENT_FIELD_HELPERS}
  const describe = (node) => {
    const type = String(node.type || node.tagName || "").toLowerCase();
    const autocomplete = token(node);
    const kind = paymentKind(node);
    if (!kind) return null;
    const rect = node.getBoundingClientRect();
    const label = String(node.labels?.[0]?.innerText || node.getAttribute("aria-label") || node.placeholder || node.name || kind).replace(/\s+/g, " ").trim().slice(0, 500);
    return { kind, label, type: type.slice(0, 100), autocomplete: autocomplete.slice(0, 100), rect: { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) }, node };
  };
  const fields = Array.from(document.querySelectorAll("input,select,textarea"))
    .filter(visible).map(describe).filter(Boolean).slice(0, 32)
    .map((field) => ({ id: fieldId(field.node), ...field }));
  const anchor = fields.find(field => field.node === document.activeElement) || fields.find(field => field.kind === "card-number");
  const selectedFields = anchor ? fields.filter(field => owner(field.node) === owner(anchor.node) && section(field.node) === section(anchor.node)) : [];
  if (!selectedFields.some((field) => field.kind === "card-number")) return { fields: [] };
  return { fields: selectedFields.map(({ node, ...field }) => ({ ...field, value: field.kind === "security-code" ? "" : String(node.value || "").slice(0, 2_000) })) };
})()`;

export function paymentFillScript(
	card: {
		cardNumber: string;
		expirationMonth: string;
		expirationYear: string;
		cardholderName: string;
		postalCode: string;
	},
	targetFieldId?: string,
	expectedOrigin?: string,
): string {
	const cardLiteral = JSON.stringify(card);
	const targetIdLiteral = JSON.stringify(targetFieldId ?? "");
	const originLiteral = JSON.stringify(expectedOrigin ?? "");
	return String.raw`(() => {
  ${PAYMENT_FIELD_HELPERS}
  if (${originLiteral} && location.origin !== ${originLiteral}) return false;
  const describe = paymentKind;
  const fields = Array.from(document.querySelectorAll("input,select,textarea")).filter(visible).map((node) => ({ node, id: fieldId(node), kind: describe(node) })).filter((field) => field.kind).slice(0, 32);
  const setValue = (node, value) => {
    const prototype = node.tagName === "INPUT" ? HTMLInputElement.prototype : node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    if (node.tagName === "SELECT") {
      const kind = paymentKind(node);
      const option = Array.from(node.options).find(item => !item.disabled && !item.parentElement?.disabled && [item.value, item.textContent?.trim()].some(text => text?.toLowerCase() === value.toLowerCase() || (/^\d+$/.test(text || "") && /^\d+$/.test(value) && (Number(text) === Number(value) || (kind === "expiration-year" && text.length === 4 && text.slice(-2) === value)))));
      if (!option) return false;
      value = option.value;
    }
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(node, value); else node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return node.isConnected && node.value === value;
  };
  const formattedExpiry = ${cardLiteral}.expirationMonth + "/" + ${cardLiteral}.expirationYear;
  const valueFor = (kind) => {
    if (kind === "card-number") return ${cardLiteral}.cardNumber;
    if (kind === "expiration") return formattedExpiry;
    if (kind === "expiration-month") return ${cardLiteral}.expirationMonth;
    if (kind === "expiration-year") return ${cardLiteral}.expirationYear;
    if (kind === "cardholder-name") return ${cardLiteral}.cardholderName;
    if (kind === "postal-code") return ${cardLiteral}.postalCode;
    return "";
  };
  const targetId = ${targetIdLiteral};
  if (targetId) {
    const target = fields.find(field => field.id === targetId);
    if (!target || target.kind === "security-code") return false;
    const filled = setValue(target.node, valueFor(target.kind));
    if (filled) target.node.focus();
    return filled;
  }
  const anchor = fields.find(field => field.node === document.activeElement) || fields.find(field => field.kind === "card-number");
  if (!anchor) return false;
  const form = owner(anchor.node);
  const group = section(anchor.node);
  let filled = 0;
  for (const field of fields) {
    if (fieldId(field.node) !== field.id || field.kind === "security-code" || field.node.value || !visible(field.node) || paymentKind(field.node) !== field.kind || owner(field.node) !== form || section(field.node) !== group || (${originLiteral} && location.origin !== ${originLiteral})) continue;
    const value = valueFor(field.kind);
    if (!value) continue;
    if (setValue(field.node, value)) filled += 1;
  }
  return filled > 0;
})()`;
}
