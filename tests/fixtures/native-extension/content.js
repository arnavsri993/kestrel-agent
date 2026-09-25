chrome.runtime.sendMessage("kestrel-probe", (result) => {
  if (chrome.runtime.lastError || !result) return;
  document.documentElement.dataset.kestrelExtensionProbe = JSON.stringify(result);
});
