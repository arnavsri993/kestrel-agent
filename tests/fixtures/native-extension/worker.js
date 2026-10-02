chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message !== "kestrel-probe") return;
  chrome.storage.local.get({ runs: 0 }).then(async ({ runs }) => {
    await chrome.storage.local.set({ runs: runs + 1 });
    reply({ runs: runs + 1, id: chrome.runtime.id, manifest: chrome.runtime.getManifest().manifest_version });
  });
  return true;
});
