const scanBtn = document.getElementById("scanBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

scanBtn.addEventListener("click", async () => {
  setBusy(true, "Starting image OCR scan...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "RUN_OCR_FROM_POPUP"
    });

    if (response?.ok) {
      setStatus("Scan started. Watch on-page OCR progress.");
    } else {
      setStatus(`Scan failed: ${response?.error || "Unknown error"}`);
    }
  } catch (error) {
    setStatus(`Scan failed: ${String(error)}`);
  } finally {
    setBusy(false);
  }
});

clearBtn.addEventListener("click", async () => {
  clearBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_OCR_FROM_POPUP" });
    setStatus("Overlay cleared.");
  } catch (error) {
    setStatus(`Clear failed: ${String(error)}`);
  } finally {
    clearBtn.disabled = false;
  }
});

function setBusy(isBusy, text = "") {
  scanBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  if (text) {
    setStatus(text);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
