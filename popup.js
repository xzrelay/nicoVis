const DEFAULT_PERCENT = 65;
const DEFAULT_ENABLED = true;

const container = document.querySelector(".container");
const toggle = document.getElementById("toggle");
const slider = document.getElementById("slider");
const percentInput = document.getElementById("percent-input");
const presets = document.querySelectorAll(".preset-btn");

let currentPercent = DEFAULT_PERCENT;
let isEnabled = DEFAULT_ENABLED;

const clamp = (value) => Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

const updateUI = (percent) => {
  const safe = clamp(percent);
  currentPercent = safe;
  slider.value = safe;
  percentInput.value = safe;

  presets.forEach((btn) => {
    btn.classList.toggle("selected", Number(btn.dataset.value) === safe);
  });
};

const updateEnabled = (enabled) => {
  isEnabled = enabled;
  toggle.checked = enabled;
  container.classList.toggle("disabled", !enabled);
};

let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ hidePercent: currentPercent, enabled: isEnabled });
  }, 150);
};

// Init
chrome.storage.sync.get(
  { hidePercent: DEFAULT_PERCENT, enabled: DEFAULT_ENABLED },
  (items) => {
    updateUI(items.hidePercent);
    updateEnabled(items.enabled);
  }
);

// Check if content script is active on the current tab
const reloadBanner = document.getElementById("reload-banner");
const reloadBtn = document.getElementById("reload-btn");

const pingContentScript = (tabId, onDone) => {
  chrome.tabs.sendMessage(tabId, { type: "ping" }, (response) => {
    const ok = !chrome.runtime.lastError && response?.active;
    onDone(ok);
  });
};

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;

  const url = tab.url || "";
  if (!url.includes("nicovideo.jp")) return;

  pingContentScript(tab.id, (ok) => {
    if (ok) {
      reloadBanner.style.display = "none";
      return;
    }

    // Run one delayed retry to avoid false negatives during page transition.
    setTimeout(() => {
      pingContentScript(tab.id, (retryOk) => {
        reloadBanner.style.display = retryOk ? "none" : "flex";
      });
    }, 300);
  });
});

reloadBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.reload(tabs[0].id);
      window.close();
    }
  });
});

// Slider
slider.addEventListener("input", () => {
  updateUI(clamp(slider.value));
  save();
});

// Number input — commit on change or Enter
percentInput.addEventListener("change", () => {
  updateUI(clamp(percentInput.value));
  save();
});

percentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    updateUI(clamp(percentInput.value));
    save();
  }
});

// Toggle
toggle.addEventListener("change", () => {
  updateEnabled(toggle.checked);
  save();
});

// Presets
presets.forEach((btn) => {
  btn.addEventListener("click", () => {
    updateUI(clamp(btn.dataset.value));
    save();
  });
});
