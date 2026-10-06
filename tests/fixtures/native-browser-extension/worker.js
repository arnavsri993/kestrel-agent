chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message !== "kestrel-probe") return;
  (async () => {
    const { runs = 0 } = await chrome.storage.local.get("runs");
    await chrome.storage.local.set({ runs: runs + 1 });
    await chrome.action.setBadgeText({ text: "CEF" });
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{ id: 1, priority: 1, action: { type: "block" },
        condition: { urlFilter: "/native-block-probe", resourceTypes: ["xmlhttprequest"] } }],
    });
    const tabs = await chrome.tabs.query({});
    reply({ runs: runs + 1, id: chrome.runtime.id, manifest: 3,
      tabs: tabs.length, badge: await chrome.action.getBadgeText({}),
      scripting: typeof chrome.scripting.executeScript === "function" });
  })().catch(error => reply({ error: String(error) }));
  return true;
});
