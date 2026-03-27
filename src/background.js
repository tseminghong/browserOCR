const MENU_IDS = {
  runOcr: "browser-ocr-run",
  googleSelection: "browser-ocr-google-selection",
  geminiSelection: "browser-ocr-gemini-selection",
  chatgptSelection: "browser-ocr-chatgpt-selection"
};

const CONTENT_SCRIPT_FILES = ["src/vendor/tesseract.min.js", "src/content.js"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IDS.runOcr,
      title: "Scan image text (OCR)",
      contexts: ["page", "action"]
    });

    chrome.contextMenus.create({
      id: MENU_IDS.googleSelection,
      title: "Search selected text on Google",
      contexts: ["selection"]
    });

    chrome.contextMenus.create({
      id: MENU_IDS.geminiSelection,
      title: "Ask Gemini about selected text",
      contexts: ["selection"]
    });

    chrome.contextMenus.create({
      id: MENU_IDS.chatgptSelection,
      title: "Ask ChatGPT about selected text",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }

  if (info.menuItemId === MENU_IDS.runOcr) {
    try {
      await startOcrForTab(tab);
    } catch (error) {
      console.error("Failed to start OCR scan:", error);
    }
    return;
  }

  const selectionText = (info.selectionText || "").trim();
  if (!selectionText) {
    return;
  }

  if (info.menuItemId === MENU_IDS.googleSelection) {
    await openInTab(tab.windowId, `https://www.google.com/search?q=${encodeURIComponent(selectionText)}`);
    return;
  }

  const prompt = buildPrompt(selectionText);

  if (info.menuItemId === MENU_IDS.geminiSelection) {
    await openInTab(tab.windowId, "https://gemini.google.com/app");
    await notifyPromptCopied(tab.id, prompt, "Gemini");
    return;
  }

  if (info.menuItemId === MENU_IDS.chatgptSelection) {
    await openInTab(tab.windowId, `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`);
    await notifyPromptCopied(tab.id, prompt, "ChatGPT");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_OCR_FROM_POPUP") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab found." });
        return;
      }

      try {
        await startOcrForTab(tab);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    });

    return true;
  }

  if (message?.type === "CLEAR_OCR_FROM_POPUP") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: true });
        return;
      }

      try {
        await sendMessage(tab.id, { type: "CLEAR_OCR_OVERLAY" });
      } catch {
        // Ignore when content script is not present on the current tab.
      }

      sendResponse({ ok: true });
    });

    return true;
  }

  return false;
});

function buildPrompt(selectedText) {
  return `Please help me understand this text from a webpage:\n\n${selectedText}`;
}

async function startOcrForTab(tab) {
  if (!tab.id || !tab.windowId) {
    return;
  }

  const unsupportedReason = getUnsupportedTabReason(tab.url || "");
  if (unsupportedReason) {
    throw new Error(unsupportedReason);
  }

  await ensureContentScript(tab.id);

  const dataUrl = await captureVisible(tab.windowId);
  await sendMessage(tab.id, {
    type: "START_OCR_SCAN",
    imageDataUrl: dataUrl
  });
}

function captureVisible(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error.message);
        return;
      }

      if (!dataUrl) {
        reject("Unable to capture current tab.");
        return;
      }

      resolve(dataUrl);
    });
  });
}

function sendMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error.message);
        return;
      }

      resolve();
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendMessage(tabId, { type: "PING_OCR" });
    return;
  } catch (error) {
    if (!String(error).includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await executeScript(tabId, CONTENT_SCRIPT_FILES);

  try {
    await sendMessage(tabId, { type: "PING_OCR" });
  } catch (error) {
    throw new Error(`Unable to initialize OCR on this page. ${String(error)}`);
  }
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files
      },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error.message);
          return;
        }

        resolve();
      }
    );
  });
}

function getUnsupportedTabReason(url) {
  if (!url) {
    return "Cannot run OCR on this tab.";
  }

  const blockedSchemes = ["chrome://", "edge://", "about:", "devtools://", "chrome-extension://"];
  if (blockedSchemes.some((scheme) => url.startsWith(scheme))) {
    return "OCR cannot run on browser internal pages. Open a normal website tab and try again.";
  }

  return "";
}

function openInTab(windowId, url) {
  return chrome.tabs.create({
    windowId,
    url,
    active: true
  });
}

async function notifyPromptCopied(tabId, prompt, provider) {
  try {
    await sendMessage(tabId, {
      type: "COPY_PROMPT",
      prompt,
      provider
    });
  } catch {
    // Ignore if content script is not ready.
  }
}
