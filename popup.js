const DEFAULT_PERCENT = 65;
const DEFAULT_ENABLED = true;
const DEFAULT_AUTO_BY_COMMENT = true;
const DEFAULT_COMMENT_THRESHOLD = 2000;

const SAVE_DEBOUNCE_MS = 150;
const PING_RETRY_DELAY_MS = 300;

const container = document.querySelector(".container");
const toggle = document.getElementById("toggle");
const autoCommentToggle = document.getElementById("auto-comment-toggle");
const commentThresholdInput = document.getElementById("comment-threshold-input");
const slider = document.getElementById("slider");
const percentInput = document.getElementById("percent-input");
const presets = document.querySelectorAll(".preset-btn");
const reloadBanner = document.getElementById("reload-banner");
const reloadBtn = document.getElementById("reload-btn");

let currentPercent = DEFAULT_PERCENT;
let isEnabled = DEFAULT_ENABLED;
let autoByCommentCount = DEFAULT_AUTO_BY_COMMENT;
let commentThreshold = DEFAULT_COMMENT_THRESHOLD;

const clamp = (value) => Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
const clampThreshold = (value) => Math.max(0, Math.round(Number(value) || 0));

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

const updateAutoByComment = (enabled) => {
  autoByCommentCount = Boolean(enabled);
  autoCommentToggle.checked = autoByCommentCount;
};

const updateCommentThreshold = (value) => {
  commentThreshold = clampThreshold(value);
  commentThresholdInput.value = commentThreshold;
};

let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({
      hidePercent: currentPercent,
      enabled: isEnabled,
      autoByCommentCount,
      commentThreshold,
    });
  }, SAVE_DEBOUNCE_MS);
};

// Init
chrome.storage.sync.get(
  {
    hidePercent: DEFAULT_PERCENT,
    enabled: DEFAULT_ENABLED,
    autoByCommentCount: DEFAULT_AUTO_BY_COMMENT,
    commentThreshold: DEFAULT_COMMENT_THRESHOLD,
  },
  (items) => {
    updateUI(items.hidePercent);
    updateEnabled(items.enabled);
    updateAutoByComment(items.autoByCommentCount);
    updateCommentThreshold(items.commentThreshold);
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  if (changes.hidePercent) {
    updateUI(changes.hidePercent.newValue);
  }
  if (changes.enabled !== undefined) {
    updateEnabled(Boolean(changes.enabled.newValue));
  }
  if (changes.autoByCommentCount !== undefined) {
    updateAutoByComment(Boolean(changes.autoByCommentCount.newValue));
  }
  if (changes.commentThreshold !== undefined) {
    updateCommentThreshold(changes.commentThreshold.newValue);
  }

  // Show reload banner only for comment-based auto ON/OFF settings
  const needsReload = 
    changes.autoByCommentCount !== undefined ||
    changes.commentThreshold !== undefined;

  if (needsReload && reloadBanner) {
    reloadBanner.style.display = "flex";
  }
});

// Check if content script is active on the current tab
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
    }, PING_RETRY_DELAY_MS);
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
percentInput.addEventListener("input", () => {
  if (percentInput.value === "") return;
  updateUI(clamp(percentInput.value));
  save();
});

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

autoCommentToggle.addEventListener("change", () => {
  updateAutoByComment(autoCommentToggle.checked);
  save();
});

commentThresholdInput.addEventListener("change", () => {
  updateCommentThreshold(commentThresholdInput.value);
  save();
});

// Presets
presets.forEach((btn) => {
  btn.addEventListener("click", () => {
    updateUI(clamp(btn.dataset.value));
    save();
  });
});
