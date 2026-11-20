chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message !== "kestrel-probe") return;
  (async () => {
    if (!sender.tab?.id || !sender.url?.startsWith("http://127.0.0.1:")) {
      throw new Error("The probe requires a local user tab.");
    }
    const { runs } = await chrome.storage.local.get({ runs: 0 });
    const tab = await chrome.tabs.get(sender.tab.id);
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => {
        document.documentElement.dataset.kestrelExtensionScriptInjected = "true";
        return {
          bridge: typeof window.kestrel,
          nativeQuery: typeof window.__kestrelNativeQuery,
        };
      },
    });
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: "/kestrel-extension-blocked",
          requestDomains: ["127.0.0.1"],
          resourceTypes: ["xmlhttprequest"],
        },
      }],
    });
    await chrome.storage.local.set({ runs: runs + 1 });
    reply({
      runs: runs + 1,
      id: chrome.runtime.id,
      manifest: chrome.runtime.getManifest().manifest_version,
      tabFound: tab.url === sender.url && tabs.some((entry) => entry.id === tab.id),
      tab: { url: tab.url, id: tab.id, senderUrl: sender.url, queriedIds: tabs.map((entry) => entry.id) },
      scripting: injection.result,
    });
  })().catch((error) => reply({ error: String(error) }));
  return true;
});
