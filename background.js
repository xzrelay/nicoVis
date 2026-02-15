const DEFAULT_ENABLED = true;

function toggleEnabled() {
  chrome.storage.sync.get({ enabled: DEFAULT_ENABLED }, (items) => {
    const current = Boolean(items.enabled);
    chrome.storage.sync.set({ enabled: !current });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-enabled") {
    toggleEnabled();
  }
});
