/** Read rendered text ranges, so a scrolled container cannot substitute its prefix. */
export const PAGE_CONTEXT_VISIBLE_TEXT_SCRIPT = String.raw`(() => {
  const maximumCharacters = 40000;
  const deadline = performance.now() + 350;
  const hidden = new WeakMap();
  const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT", "OPTION"]);
  const allowed = (element) => {
    if (!element) return false;
    if (hidden.has(element)) return !hidden.get(element);
    const style = getComputedStyle(element);
    const blocked = excluded.has(element.tagName) || style.display === "none" ||
      style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 ||
      (element.parentElement && !allowed(element.parentElement));
    hidden.set(element, Boolean(blocked));
    return !blocked;
  };
  const intersects = (rect) => rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  const inside = (rect) => rect.top >= 0 && rect.left >= 0 &&
    rect.bottom <= innerHeight && rect.right <= innerWidth;
  const parts = [];
  let characters = 0;
  let ranges = 0;
  let lastBottom;
  let lastTop;
  let truncated = false;
  const append = (text, rect) => {
    if (!text) return;
    if (lastTop !== undefined && rect.top >= lastBottom - 1 && rect.top > lastTop + 2) {
      parts.push("\n"); characters += 1;
    }
    const remaining = maximumCharacters - characters;
    if (text.length > remaining) truncated = true;
    const value = text.slice(0, Math.max(0, remaining));
    parts.push(value); characters += value.length;
    lastTop = rect.top; lastBottom = rect.bottom;
  };
  const range = document.createRange();
  const collect = (node, start, end) => {
    if (characters >= maximumCharacters || ranges >= 50000 || performance.now() > deadline) {
      truncated = true; return;
    }
    ranges += 1;
    range.setStart(node, start); range.setEnd(node, end);
    const rect = range.getBoundingClientRect();
    if (!intersects(rect)) return;
    if (inside(rect) || end - start <= 1) {
      append(node.data.slice(start, end), rect); return;
    }
    const middle = start + Math.floor((end - start) / 2);
    collect(node, start, middle); collect(node, middle, end);
  };
  if (!document.body) return "";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let visited = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (++visited > 20000 || characters >= maximumCharacters || ranges >= 50000 || performance.now() > deadline) {
      truncated = true; break;
    }
    if (node.data.length && allowed(node.parentElement)) collect(node, 0, node.data.length);
  }
  range.detach();
  const text = parts.join("").trim();
  return truncated ? text.slice(0, maximumCharacters - 35) + "\n[Visible text capture truncated]" : text;
})()`;
