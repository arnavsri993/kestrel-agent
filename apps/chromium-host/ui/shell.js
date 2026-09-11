const $ = (id) => document.getElementById(id);
const call = (command) => window.kestrelHost(command);
let sending = false;
let initialized = false;
let transcriptSignature = "";
let currentSession = "";
let refreshNumber = 0;
const drafts = new Map();
const narrow = matchMedia("(max-width: 760px)");
function arrangeBrowserTools() { $("browser-tools").open = !narrow.matches; }
narrow.addEventListener("change", arrangeBrowserTools);
arrangeBrowserTools();
function error(cause) { $("error").textContent = cause.message || "The operation failed."; $("error").hidden = false; }
function clearError() { $("error").hidden = true; }
function button(text, action, label) {
  const node = document.createElement("button"); node.textContent = text;
  if (label) node.setAttribute("aria-label", label);
  node.addEventListener("click", () => run(action)); return node;
}
async function run(action) { clearError(); try { await action(); await refresh(); } catch (cause) { error(cause); } }
async function refresh() {
  const ticket = ++refreshNumber;
  const state = await call({ type: "state" });
  if (ticket !== refreshNumber) return;
  if (currentSession !== state.sessionId) {
    if (currentSession) drafts.set(currentSession, $("message").value);
    currentSession = state.sessionId;
    $("message").value = drafts.get(currentSession) || "";
  }
  $("status").textContent = state.busy ? "Responding…" : "Core connected";
  $("title").textContent = state.sessions.find((session) => session.id === state.sessionId)?.title || "Conversation";
  $("conversations").replaceChildren(...state.sessions.map((session) => {
    const node = button(session.title, () => call({ type: "select-conversation", id: session.id }));
    node.classList.toggle("selected", session.id === state.sessionId);
    node.setAttribute("aria-current", String(session.id === state.sessionId)); node.disabled = sending; return node;
  }));
  $("tabs").replaceChildren(...state.tabs.map((tab) => {
    const row = document.createElement("div"); row.className = "tab-entry";
    const link = button("", () => call({ type: "focus-tab", id: tab.id }), `Switch to ${tab.title || tab.url}`);
    link.title = tab.url;
    const title = document.createElement("span"); title.className = "tab-title"; title.textContent = tab.title || "Browser tab";
    const url = document.createElement("span"); url.className = "tab-url"; url.textContent = tab.url;
    link.append(title, url); row.append(link);
    row.append(button("×", () => call({ type: "close-tab", id: tab.id }), `Close ${tab.title || tab.url}`)); return row;
  }));
  $("browser-summary").textContent = `Browser tabs (${state.tabs.length})`;
  const selection = $("provider").value;
  $("provider").replaceChildren(...state.providers.map((provider) => { const option = document.createElement("option"); option.value = provider; option.textContent = provider; return option; }));
  if (state.providers.includes(selection)) $("provider").value = selection;
  if (!initialized) { $("model").value = state.model; initialized = true; }
  $("provider-note").textContent = state.providers.length ? "Browser reading is optional · Enter to send, Shift+Enter for a new line." : "No model provider configured. Start the preview with supported provider environment settings; existing desktop logins are not imported.";
  $("send").disabled = sending || !state.providers.length;
  $("new-conversation").disabled = sending;
  const messages = state.messages.filter((message) => message.role === "user" || message.role === "assistant");
  const signature = JSON.stringify([state.sessionId, messages]);
  if (signature !== transcriptSignature) {
    transcriptSignature = signature;
    if (messages.length) {
      $("transcript").replaceChildren(...messages.map((message) => {
        const article = document.createElement("article"); article.className = "message";
        const heading = document.createElement("h2"); heading.textContent = message.role === "user" ? "You" : "Kestrel";
        const content = document.createElement("p"); content.textContent = message.content;
        article.append(heading, content); return article;
      }));
      $("transcript").scrollTop = $("transcript").scrollHeight;
    } else {
      const empty = document.createElement("p"); empty.className = "note"; empty.textContent = "Start a conversation with your configured model.";
      if (!$("empty")) $("transcript").replaceChildren(empty);
    }
  }
}
$("new-conversation").addEventListener("click", () => run(() => call({ type: "new-conversation" })));
$("browser-form").addEventListener("submit", (event) => { event.preventDefault(); run(() => call({ type: "open-tab", url: $("url").value })); });
$("cancel").addEventListener("click", () => run(() => call({ type: "cancel" })));
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault(); if (sending || !$("message").value.trim()) return;
  clearError(); sending = true; $("message").readOnly = true; $("send").disabled = true; $("cancel").hidden = false;
  const message = $("message").value;
  const timer = setInterval(() => refresh().catch(error), 700);
  try { await call({ type: "send", message, provider: $("provider").value, model: $("model").value, readBrowser: $("read-browser").checked }); $("message").value = ""; drafts.set(currentSession, ""); }
  catch (cause) { error(cause); }
  finally { $("read-browser").checked = false; clearInterval(timer); sending = false; $("message").readOnly = false; $("cancel").hidden = true; await refresh().catch(error); }
});
$("message").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("send").disabled) $("composer").requestSubmit(); } });
window.addEventListener("kestrel-tabs-changed", () => refresh().catch(error));
window.addEventListener("focus", () => refresh().catch(error));
refresh().catch(error);
