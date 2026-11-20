chrome.storage.local.get({ runs: 0 }).then(({ runs }) => {
  document.getElementById("storage").textContent = `Stored runs: ${runs}`;
  document.documentElement.dataset.kestrelExtensionPopup = JSON.stringify({
    id: chrome.runtime.id,
    runs,
    bridge: typeof window.kestrel,
    nativeQuery: typeof window.__kestrelNativeQuery,
  });
});
