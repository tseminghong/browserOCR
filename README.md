# Browser OCR Assistant (Chrome Extension)

This extension performs true image OCR on the current browser view, then lets you select detected words and quickly:
- Copy selected text
- Search on Google
- Ask Gemini
- Ask ChatGPT

## What is improved

- Uses a **hybrid pipeline** for better compatibility and lower power: DOM text -> TextDetector -> Tesseract OCR fallback.

- Uses **Tesseract OCR** on captured page images (works for image/canvas-rendered text, not only DOM text).
- Runs two OCR preprocessing passes for better detection on blurry/light backgrounds.
- Shows OCR progress while language/model files load and recognition runs.
- Drag-select word boxes, then use a floating action toolbar.

## Features

- Popup action: `Scan Image Text`.
- Right-click action: `Scan page words (OCR)`.
- Floating toolbar actions: `Copy`, `Google`, `Ask Gemini`, `Ask ChatGPT`, `Clear`.
- `Esc` key closes overlay instantly.
- Right-click shortcuts for normal browser-selected text:
  - Search selected text on Google
  - Ask Gemini about selected text
  - Ask ChatGPT about selected text

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select folder:
   - `C:\Users\Darren\Documents\codex\browserOCR`

## How to use

1. Open your target page.
2. Click extension icon, then click **Scan Image Text**.
3. Wait for OCR to finish (first run may take longer).
4. Circle text on the page (like Circle-to-Search) to select words/phrases.
5. Use floating toolbar to copy/search/ask AI.

## First-run behavior

- First scan may take extra time because language models are downloaded and cached.
- Extension uses `eng` + `chi_sim` OCR models for mixed English/Chinese pages.

## Notes

- For best OCR accuracy, zoom page to `110%` to `150%` and scan again.
- For `Ask Gemini`, prompt text is copied to clipboard and Gemini is opened.
- For `Ask ChatGPT`, prompt is copied and ChatGPT opens with query URL.




