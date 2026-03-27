const ROOT_ID = "browser-ocr-root";
const STYLE_ID = "browser-ocr-style";
const DOM_FAST_MIN_WORDS = 24;
const TEXT_DETECTOR_MIN_WORDS = 12;

const state = {
  root: null,
  overlay: null,
  toolbar: null,
  hint: null,
  toast: null,
  lassoSvg: null,
  lassoPath: null,
  lassoPoints: [],
  words: [],
  wordElements: [],
  selectedIndexes: new Set(),
  dragSelecting: false,
  dragMoved: false,
  suppressOverlayClick: false,
  dragPointerId: null,
  dragSeedIndex: null,
  dragStartX: 0,
  dragStartY: 0,
  baseSelection: new Set(),
  isBusy: false,
  ocrWorker: null,
  ocrWorkerPromise: null,
  ocrProgressStep: -1,
  ocrLanguageProfile: "eng",
  keyHandler: null,
  lastScanSource: "ocr"
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING_OCR") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "START_OCR_SCAN") {
    runScan(message.imageDataUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));

    return true;
  }

  if (message?.type === "CLEAR_OCR_OVERLAY") {
    clearOverlay();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "COPY_PROMPT") {
    copyText(message.prompt || "")
      .then(() => {
        showToast(`Prompt copied for ${message.provider || "assistant"}.`);
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));

    return true;
  }

  return false;
});

async function runScan(imageDataUrl) {
  if (state.isBusy) {
    showToast("Scan is already running.");
    return;
  }

  if (!imageDataUrl) {
    showToast("No screenshot received for scan.");
    return;
  }

  state.isBusy = true;
  state.ocrProgressStep = -1;

  ensureStyles();
  ensureRoot();

  try {
    showToast("Analyzing page text...");

    const detection = await detectWordsByBestMethod(imageDataUrl);
    const words = detection.words;

    if (!words.length) {
      clearOverlay();
      showToast("No words detected. Try zooming in and scan again.");
      return;
    }

    state.lastScanSource = detection.source;
    renderWordBoxes(words, detection.source);
    showToast(`Detected ${words.length} words (${detection.source}). Circle text to select.`);
  } catch (error) {
    clearOverlay();
    const message = getErrorMessage(error);
    showToast(`Scan failed: ${message}`);
    throw new Error(message);
  } finally {
    state.isBusy = false;
  }
}

async function detectWordsByBestMethod(imageDataUrl) {
  const domWords = normalizeWords(detectWordsFromDOM());
  if (domWords.length >= DOM_FAST_MIN_WORDS) {
    return { words: domWords, source: "DOM fast" };
  }

  const textDetectorWords = normalizeWords(await detectWordsWithTextDetector(imageDataUrl));
  if (textDetectorWords.length >= TEXT_DETECTOR_MIN_WORDS) {
    return { words: textDetectorWords, source: "TextDetector" };
  }

  const imageWords = await detectWordsFromScreenshot(imageDataUrl);
  return { words: imageWords, source: "Image OCR" };
}

function detectWordsFromDOM() {
  const words = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const maxWords = 5000;

  while (walker.nextNode() && words.length < maxWords) {
    const textNode = walker.currentNode;
    const text = textNode.nodeValue;

    if (!text || !text.trim()) {
      continue;
    }

    const parent = textNode.parentElement;
    if (!parent || !isElementVisible(parent) || shouldIgnoreNode(parent)) {
      continue;
    }

    const regex = /\S+/g;
    let match;

    while ((match = regex.exec(text)) && words.length < maxWords) {
      const token = cleanToken(match[0]);
      if (!token) {
        continue;
      }

      const range = document.createRange();
      range.setStart(textNode, match.index);
      range.setEnd(textNode, match.index + match[0].length);
      const rects = Array.from(range.getClientRects());

      for (const rect of rects) {
        if (rect.width < 3 || rect.height < 3) {
          continue;
        }

        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
          continue;
        }

        words.push({
          text: token,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          confidence: 100
        });
      }
    }
  }

  return words;
}

function shouldIgnoreNode(element) {
  const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
  return ignoredTags.has(element.tagName);
}

async function detectWordsWithTextDetector(imageDataUrl) {
  if (!("TextDetector" in window) || !imageDataUrl) {
    return [];
  }

  try {
    const image = await loadImage(imageDataUrl);
    const bitmap = await createImageBitmap(image);
    const detector = new TextDetector();
    const blocks = await detector.detect(bitmap);

    if (!blocks?.length) {
      return [];
    }

    const scaleX = window.innerWidth / image.naturalWidth;
    const scaleY = window.innerHeight / image.naturalHeight;
    const words = [];

    for (const block of blocks) {
      const text = cleanToken(block.rawValue || "");
      const box = block.boundingBox;

      if (!text || !box || box.width < 2 || box.height < 2) {
        continue;
      }

      const tokens = text.split(/\s+/).filter(Boolean);
      const unitWidth = box.width / Math.max(tokens.length, 1);

      for (let i = 0; i < tokens.length; i += 1) {
        words.push({
          text: tokens[i],
          left: (box.x + unitWidth * i) * scaleX,
          top: box.y * scaleY,
          width: unitWidth * scaleX,
          height: box.height * scaleY,
          confidence: 90
        });
      }
    }

    return words;
  } catch {
    return [];
  }
}

async function detectWordsFromScreenshot(imageDataUrl) {
  const image = await loadImage(imageDataUrl);
  const worker = await getOcrWorker();
  await ensureOcrLanguages(worker, "eng");

  const primary = preprocessImage(image, { mode: "contrast" });
  showToast("Running OCR pass 1...");
  let words = await recognizeWords(worker, primary, image);

  if (words.length < 25) {
    const fallback = preprocessImage(image, { mode: "clean" });
    showToast("Running OCR pass 2 for better coverage...");
    const secondPassWords = await recognizeWords(worker, fallback, image);
    words = mergeWordLists(words, secondPassWords);
  }

  if (words.length < 18) {
    showToast("Retrying OCR with English + Traditional Chinese...");
    await ensureOcrLanguages(worker, "eng+chi_tra");
    const bilingual = preprocessImage(image, { mode: "clean" });
    const bilingualWords = await recognizeWords(worker, bilingual, image);
    words = mergeWordLists(words, bilingualWords);
  }

  return normalizeWords(words);
}

async function recognizeWords(worker, processedImage, sourceImage) {
  const result = await worker.recognize(processedImage.canvas, {}, { blocks: true });
  const rawWords = extractWordsFromOcrData(result?.data || {});

  if (!rawWords.length) {
    return [];
  }

  const sourceScaleX = sourceImage.naturalWidth / processedImage.canvas.width;
  const sourceScaleY = sourceImage.naturalHeight / processedImage.canvas.height;
  const viewportScaleX = window.innerWidth / sourceImage.naturalWidth;
  const viewportScaleY = window.innerHeight / sourceImage.naturalHeight;

  return rawWords
    .filter((word) => word.text.length > 0)
    .map((word) => ({
      text: word.text,
      left: word.left * sourceScaleX * viewportScaleX,
      top: word.top * sourceScaleY * viewportScaleY,
      width: word.width * sourceScaleX * viewportScaleX,
      height: word.height * sourceScaleY * viewportScaleY,
      confidence: word.confidence
    }));
}

function extractWordsFromOcrData(data) {
  const directWords = mapNodesToWordEntries(Array.isArray(data.words) ? data.words : []);
  if (directWords.length) {
    return directWords;
  }

  const wordNodes = [];
  const leafNodes = [];
  const queue = [data];
  const childKeys = ["blocks", "paragraphs", "lines", "words", "symbols", "children"];

  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== "object") {
      continue;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        queue.push(item);
      }
      continue;
    }

    let hasChildren = false;

    if (Array.isArray(node.words) && node.words.length) {
      wordNodes.push(...node.words);
    }

    for (const key of childKeys) {
      const children = node[key];
      if (Array.isArray(children) && children.length) {
        hasChildren = true;
        for (const child of children) {
          queue.push(child);
        }
      }
    }

    if (!hasChildren) {
      leafNodes.push(node);
    }
  }

  const nestedWords = mapNodesToWordEntries(wordNodes);
  if (nestedWords.length) {
    return nestedWords;
  }

  return mapNodesToWordEntries(leafNodes);
}

function mapNodesToWordEntries(nodes) {
  const words = [];

  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }

    const text = cleanToken(node.text || node.rawValue || "");
    const rect = readRect(node.bbox || node.boundingBox || node.box);
    const confidence = Number(node.confidence ?? node.conf ?? 100);

    if (!text || !rect || confidence < 35) {
      continue;
    }

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }

    if (tokens.length === 1) {
      words.push({
        text: tokens[0],
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        confidence
      });
      continue;
    }

    const unitWidth = rect.width / tokens.length;
    for (let i = 0; i < tokens.length; i += 1) {
      words.push({
        text: tokens[i],
        left: rect.left + unitWidth * i,
        top: rect.top,
        width: unitWidth,
        height: rect.height,
        confidence
      });
    }
  }

  return words;
}

function readRect(box) {
  if (!box || typeof box !== "object") {
    return null;
  }

  if (isFiniteNumber(box.x0) && isFiniteNumber(box.y0) && isFiniteNumber(box.x1) && isFiniteNumber(box.y1)) {
    return {
      left: box.x0,
      top: box.y0,
      width: Math.max(1, box.x1 - box.x0),
      height: Math.max(1, box.y1 - box.y0)
    };
  }

  if (isFiniteNumber(box.x) && isFiniteNumber(box.y) && isFiniteNumber(box.w) && isFiniteNumber(box.h)) {
    return {
      left: box.x,
      top: box.y,
      width: Math.max(1, box.w),
      height: Math.max(1, box.h)
    };
  }

  if (isFiniteNumber(box.x) && isFiniteNumber(box.y) && isFiniteNumber(box.width) && isFiniteNumber(box.height)) {
    return {
      left: box.x,
      top: box.y,
      width: Math.max(1, box.width),
      height: Math.max(1, box.height)
    };
  }

  if (isFiniteNumber(box.left) && isFiniteNumber(box.top) && isFiniteNumber(box.right) && isFiniteNumber(box.bottom)) {
    return {
      left: box.left,
      top: box.top,
      width: Math.max(1, box.right - box.left),
      height: Math.max(1, box.bottom - box.top)
    };
  }

  return null;
}

function preprocessImage(image, options = { mode: "contrast" }) {
  const maxDimension = 2800;
  const upscale = 1.6;
  const ratio = Math.min(upscale, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;

  const width = Math.max(1, Math.round(image.naturalWidth * safeRatio));
  const height = Math.max(1, Math.round(image.naturalHeight * safeRatio));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];

    let gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (options.mode === "contrast") {
      gray = (gray - 128) * 1.45 + 128;
      if (gray > 205) {
        gray = 255;
      } else if (gray < 42) {
        gray = 0;
      }
    } else {
      gray = (gray - 128) * 1.2 + 128;
    }

    const value = Math.max(0, Math.min(255, gray));
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
  }

  ctx.putImageData(imageData, 0, 0);

  return {
    canvas,
    ratio: safeRatio
  };
}

function mergeWordLists(first, second) {
  const merged = [...first, ...second];
  return normalizeWords(merged);
}

function normalizeWords(words) {
  const deduped = new Map();

  for (const word of words) {
    const text = cleanToken(word.text || "");
    if (!text) {
      continue;
    }

    const left = Math.max(0, Math.min(window.innerWidth - 1, Math.round(word.left)));
    const top = Math.max(0, Math.min(window.innerHeight - 1, Math.round(word.top)));
    const width = Math.max(2, Math.round(word.width));
    const height = Math.max(2, Math.round(word.height));

    if (width < 4 || height < 4) {
      continue;
    }

    const confidence = Number.isFinite(word.confidence) ? word.confidence : 100;
    const key = `${text}|${Math.round(left / 2)}|${Math.round(top / 2)}|${Math.round(width / 2)}|${Math.round(height / 2)}`;

    const existing = deduped.get(key);
    if (!existing || confidence > existing.confidence) {
      deduped.set(key, {
        text,
        left,
        top,
        width,
        height,
        confidence
      });
    }
  }

  const compactWords = Array.from(deduped.values()).sort((a, b) => b.confidence - a.confidence);
  return suppressOverlappingWords(compactWords);
}

function suppressOverlappingWords(words) {
  const kept = [];

  for (const word of words) {
    let shouldDrop = false;

    for (const existing of kept) {
      const overlap = intersectionOverSmallerArea(word, existing);
      const sameText = word.text === existing.text;
      if (overlap > 0.82 || (sameText && overlap > 0.6)) {
        shouldDrop = true;
        break;
      }
    }

    if (!shouldDrop) {
      kept.push(word);
    }
  }

  return kept;
}

function intersectionOverSmallerArea(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);

  const intersectionWidth = Math.max(0, right - left);
  const intersectionHeight = Math.max(0, bottom - top);

  if (intersectionWidth <= 0 || intersectionHeight <= 0) {
    return 0;
  }

  const intersection = intersectionWidth * intersectionHeight;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const smallerArea = Math.max(1, Math.min(areaA, areaB));

  return intersection / smallerArea;
}

function cleanToken(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderWordBoxes(words, sourceLabel = "scan") {
  ensureRoot();

  removeOverlayListeners();
  state.root.innerHTML = "";

  state.words = words;
  state.wordElements = new Array(words.length);
  state.selectedIndexes = new Set();
  state.baseSelection = new Set();
  state.lassoPoints = [];
  state.dragSeedIndex = null;

  const overlay = document.createElement("div");
  overlay.id = ROOT_ID;
  overlay.className = "browser-ocr-overlay";

  const layer = document.createElement("div");
  layer.className = "browser-ocr-layer";

  const lassoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lassoSvg.setAttribute("class", "browser-ocr-lasso");
  lassoSvg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  lassoSvg.setAttribute("preserveAspectRatio", "none");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  gradient.setAttribute("id", "browser-ocr-google-gradient");
  gradient.setAttribute("x1", "0%");
  gradient.setAttribute("y1", "0%");
  gradient.setAttribute("x2", "100%");
  gradient.setAttribute("y2", "0%");

  const stops = [
    { offset: "0%", color: "#4285F4" },
    { offset: "33%", color: "#EA4335" },
    { offset: "66%", color: "#FBBC05" },
    { offset: "100%", color: "#34A853" }
  ];

  for (const stopDef of stops) {
    const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
    stop.setAttribute("offset", stopDef.offset);
    stop.setAttribute("stop-color", stopDef.color);
    gradient.appendChild(stop);
  }

  defs.appendChild(gradient);
  lassoSvg.appendChild(defs);

  const lassoPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  lassoPath.setAttribute("class", "browser-ocr-lasso-path");
  lassoPath.setAttribute("d", "");
  lassoPath.setAttribute("fill", "none");
  lassoPath.setAttribute("stroke", "url(#browser-ocr-google-gradient)");
  lassoSvg.appendChild(lassoPath);

  words.forEach((word, index) => {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "browser-ocr-word";
    box.style.left = `${word.left}px`;
    box.style.top = `${word.top}px`;
    box.style.width = `${word.width}px`;
    box.style.height = `${word.height}px`;
    box.dataset.index = String(index);
    box.title = word.text;

    box.addEventListener("pointerdown", (event) => {
      beginSelectionDrag(event, index);
    });

    state.wordElements[index] = box;
    layer.appendChild(box);
  });

  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay || event.target === layer) {
      beginSelectionDrag(event, null);
    }
  });

  overlay.addEventListener("pointermove", (event) => {
    if (!state.dragSelecting || event.pointerId !== state.dragPointerId) {
      return;
    }

    event.preventDefault();

    const movedDistance = Math.abs(event.clientX - state.dragStartX) + Math.abs(event.clientY - state.dragStartY);
    state.dragMoved = movedDistance > 4;
    addLassoPoint(event.clientX, event.clientY);
    updateLassoPath();

    if (state.lassoPoints.length > 2) {
      const inShape = indexesInsideLasso(state.lassoPoints);
      const nextSelection = new Set(state.baseSelection);
      for (const index of inShape) {
        nextSelection.add(index);
      }
      setSelection(nextSelection);
    }
  });

  overlay.addEventListener("pointerup", (event) => {
    endSelectionDrag(event);
  });

  overlay.addEventListener("pointercancel", (event) => {
    endSelectionDrag(event);
  });

  overlay.addEventListener("click", (event) => {
    if (state.suppressOverlayClick) {
      state.suppressOverlayClick = false;
      return;
    }

    if ((event.target === overlay || event.target === layer) && state.selectedIndexes.size) {
      clearSelection();
    }
  });

  const toolbar = buildToolbar();
  const hint = buildHint(words.length, sourceLabel);

  overlay.appendChild(layer);
  overlay.appendChild(lassoSvg);
  overlay.appendChild(toolbar);
  overlay.appendChild(hint);

  state.overlay = overlay;
  state.toolbar = toolbar;
  state.hint = hint;
  state.lassoSvg = lassoSvg;
  state.lassoPath = lassoPath;

  state.root.appendChild(overlay);

  state.keyHandler = (event) => {
    if (event.key === "Escape") {
      clearOverlay();
    }
  };
  document.addEventListener("keydown", state.keyHandler, true);
}

function beginSelectionDrag(event, seedIndex) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const extend = event.ctrlKey || event.metaKey || event.shiftKey;

  state.dragSelecting = true;
  state.dragMoved = false;
  state.dragPointerId = event.pointerId;
  state.dragSeedIndex = Number.isInteger(seedIndex) ? seedIndex : null;
  state.dragStartX = event.clientX;
  state.dragStartY = event.clientY;
  state.baseSelection = extend ? new Set(state.selectedIndexes) : new Set();
  state.lassoPoints = [{ x: event.clientX, y: event.clientY }];

  if (!extend) {
    setSelection(new Set());
  }

  if (Number.isInteger(seedIndex)) {
    const nextSelection = new Set(state.baseSelection);
    nextSelection.add(seedIndex);
    setSelection(nextSelection);
  }

  updateLassoPath();

  if (state.overlay?.setPointerCapture) {
    try {
      state.overlay.setPointerCapture(event.pointerId);
    } catch {
      // ignore pointer capture issues
    }
  }
}

function endSelectionDrag(event) {
  if (!state.dragSelecting || event.pointerId !== state.dragPointerId) {
    return;
  }

  const baseSelectionAtEnd = new Set(state.baseSelection);
  state.dragSelecting = false;
  state.dragPointerId = null;
  state.baseSelection = new Set();
  if (!state.dragMoved && Number.isInteger(state.dragSeedIndex)) {
    const nextSelection = new Set(baseSelectionAtEnd);
    nextSelection.add(state.dragSeedIndex);
    setSelection(nextSelection);
  }

  if (state.dragMoved) {
    state.suppressOverlayClick = true;
  }

  fadeLassoPath();
  state.dragSeedIndex = null;
  state.lassoPoints = [];
  state.dragMoved = false;
  updateToolbar();
}

function addLassoPoint(x, y) {
  const points = state.lassoPoints;
  if (!points.length) {
    points.push({ x, y });
    return;
  }

  const last = points[points.length - 1];
  const dx = x - last.x;
  const dy = y - last.y;
  const distanceSq = dx * dx + dy * dy;

  if (distanceSq < 9) {
    return;
  }

  points.push({ x, y });
}

function updateLassoPath() {
  if (!state.lassoPath) {
    return;
  }

  const points = state.lassoPoints;
  if (!points.length) {
    state.lassoPath.setAttribute("d", "");
    return;
  }

  const path = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length; i += 1) {
    path.push(`L ${points[i].x} ${points[i].y}`);
  }
  state.lassoPath.setAttribute("d", path.join(" "));
  state.lassoPath.classList.add("active");
}

function fadeLassoPath() {
  if (!state.lassoPath) {
    return;
  }

  state.lassoPath.classList.remove("active");
  setTimeout(() => {
    if (state.lassoPath) {
      state.lassoPath.setAttribute("d", "");
    }
  }, 180);
}

function indexesInsideLasso(points) {
  const indexes = [];
  if (points.length < 2) {
    return indexes;
  }

  for (let i = 0; i < state.words.length; i += 1) {
    const word = state.words[i];
    const center = {
      x: word.left + word.width / 2,
      y: word.top + word.height / 2
    };

    if (isPointInPolygon(center, points) || distanceToPolyline(center, points) < 10) {
      indexes.push(i);
    }
  }

  return indexes;
}

function isPointInPolygon(point, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = yi > point.y !== yj > point.y
      && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 0.00001) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function distanceToPolyline(point, polyline) {
  let minDistance = Number.POSITIVE_INFINITY;

  for (let i = 1; i < polyline.length; i += 1) {
    const distance = pointToSegmentDistance(point, polyline[i - 1], polyline[i]);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
}

function pointToSegmentDistance(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq === 0) {
    return Math.hypot(apx, apy);
  }

  let t = (apx * abx + apy * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));

  const closestX = a.x + abx * t;
  const closestY = a.y + aby * t;

  return Math.hypot(point.x - closestX, point.y - closestY);
}

function buildHint(totalWords, sourceLabel) {
  const hint = document.createElement("div");
  hint.className = "browser-ocr-hint";
  hint.innerHTML = `<strong>Ready (${sourceLabel})</strong><span>${totalWords} words detected. Circle text to select, then use quick actions.</span>`;
  return hint;
}

function buildToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "browser-ocr-toolbar";

  const copyBtn = toolbarButton("Copy", async () => {
    const text = selectedText();
    if (!text) {
      return;
    }

    await copyText(text);
    showToast("Copied selected text.");
  });

  const googleBtn = toolbarButton("Google", () => {
    const text = selectedText();
    if (!text) {
      return;
    }

    window.open(`https://www.google.com/search?q=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  });

  const geminiBtn = toolbarButton("Ask Gemini", async () => {
    const text = selectedText();
    if (!text) {
      return;
    }

    const prompt = buildPrompt(text);
    await copyText(prompt);
    window.open("https://gemini.google.com/app", "_blank", "noopener,noreferrer");
    showToast("Prompt copied. Paste in Gemini.");
  });

  const chatgptBtn = toolbarButton("Ask ChatGPT", async () => {
    const text = selectedText();
    if (!text) {
      return;
    }

    const prompt = buildPrompt(text);
    await copyText(prompt);
    window.open(`https://chatgpt.com/?q=${encodeURIComponent(prompt)}`, "_blank", "noopener,noreferrer");
    showToast("Opened ChatGPT with your prompt.");
  });

  const clearBtn = toolbarButton("Clear", () => {
    clearOverlay();
  });

  toolbar.append(copyBtn, googleBtn, geminiBtn, chatgptBtn, clearBtn);
  return toolbar;
}

function toolbarButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browser-ocr-toolbar-btn";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function clearSelection() {
  setSelection(new Set());
}

function setSelection(nextSelection) {
  const previousSelection = state.selectedIndexes;

  for (const index of previousSelection) {
    if (!nextSelection.has(index)) {
      state.wordElements[index]?.classList.remove("selected");
    }
  }

  for (const index of nextSelection) {
    if (!previousSelection.has(index)) {
      state.wordElements[index]?.classList.add("selected");
    }
  }

  state.selectedIndexes = nextSelection;
  updateToolbar();
}

function selectedText() {
  const ordered = Array.from(state.selectedIndexes)
    .map((index) => state.words[index])
    .filter(Boolean)
    .sort((a, b) => {
      if (Math.abs(a.top - b.top) < 8) {
        return a.left - b.left;
      }
      return a.top - b.top;
    })
    .map((word) => word.text);

  return ordered.join(" ").replace(/\s+/g, " ").trim();
}

function updateToolbar() {
  if (!state.toolbar) {
    return;
  }

  if (!state.selectedIndexes.size) {
    state.toolbar.style.display = "none";
    return;
  }
  state.toolbar.style.left = "50%";
  state.toolbar.style.bottom = "18px";
  state.toolbar.style.top = "auto";
  state.toolbar.style.transform = "translateX(-50%)";
  state.toolbar.style.display = "flex";
}

function clearOverlay() {
  state.selectedIndexes = new Set();
  state.baseSelection = new Set();
  state.words = [];
  state.wordElements = [];
  state.lassoPoints = [];
  state.dragSelecting = false;
  state.dragPointerId = null;
  state.dragSeedIndex = null;
  state.dragMoved = false;
  state.suppressOverlayClick = false;

  if (state.root) {
    state.root.innerHTML = "";
  }

  removeOverlayListeners();

  state.overlay = null;
  state.toolbar = null;
  state.hint = null;
  state.lassoSvg = null;
  state.lassoPath = null;
}

function removeOverlayListeners() {
  if (state.keyHandler) {
    document.removeEventListener("keydown", state.keyHandler, true);
    state.keyHandler = null;
  }
}

function ensureRoot() {
  if (state.root && document.documentElement.contains(state.root)) {
    return;
  }

  state.root = document.getElementById("browser-ocr-container");
  if (!state.root) {
    state.root = document.createElement("div");
    state.root.id = "browser-ocr-container";
    document.documentElement.appendChild(state.root);
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #browser-ocr-container {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: "Segoe UI", Tahoma, sans-serif;
    }

    .browser-ocr-overlay {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      background: transparent;
      backdrop-filter: none;
    }

    .browser-ocr-layer {
      position: absolute;
      inset: 0;
    }

    .browser-ocr-word {
      position: fixed;
      border: 1px solid rgba(66, 133, 244, 0.22);
      background: rgba(66, 133, 244, 0.02);
      border-radius: 3px;
      cursor: pointer;
      padding: 0;
      margin: 0;
      appearance: none;
      color: transparent;
      transition: border-color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
    }

    .browser-ocr-word:hover {
      border-color: rgba(66, 133, 244, 0.65);
      background: rgba(66, 133, 244, 0.08);
    }

    .browser-ocr-word.selected {
      border-color: rgba(66, 133, 244, 0.92);
      background: rgba(66, 133, 244, 0.2);
      box-shadow: 0 0 0 1px rgba(66, 133, 244, 0.22);
    }

    .browser-ocr-lasso {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
    }

    .browser-ocr-lasso-path {
      fill: none;
      stroke-width: 5.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 1px 2px rgba(37, 99, 235, 0.32));
      opacity: 0;
      transition: opacity 0.12s ease;
    }

    .browser-ocr-lasso-path.active {
      opacity: 1;
    }

    @media (max-width: 768px) {
      .browser-ocr-lasso-path {
        stroke-width: 3.5;
      }
    }

    .browser-ocr-toolbar {
      position: fixed;
      z-index: 2147483647;
      display: none;
      gap: 6px;
      align-items: center;
      background: rgba(255, 255, 255, 0.95);
      color: #111827;
      border: 1px solid rgba(203, 213, 225, 0.9);
      border-radius: 999px;
      padding: 7px 8px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.16);
      backdrop-filter: blur(8px);
      max-width: min(96vw, 820px);
      overflow-x: auto;
    }

    .browser-ocr-toolbar-btn {
      border: 0;
      color: inherit;
      background: rgba(248, 250, 252, 0.96);
      border-radius: 999px;
      padding: 6px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }

    .browser-ocr-toolbar-btn:hover {
      background: rgba(226, 232, 240, 0.92);
    }

    .browser-ocr-hint {
      position: fixed;
      left: 50%;
      top: 12px;
      transform: translateX(-50%);
      display: grid;
      gap: 2px;
      background: rgba(255, 255, 255, 0.93);
      color: #0f172a;
      border: 1px solid rgba(203, 213, 225, 0.76);
      border-radius: 12px;
      padding: 8px 12px;
      font-size: 12px;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
      backdrop-filter: blur(6px);
      pointer-events: none;
      max-width: min(92vw, 820px);
      text-align: center;
    }

    .browser-ocr-hint strong {
      font-size: 12px;
      letter-spacing: 0.2px;
    }

    .browser-ocr-hint span {
      color: rgba(71, 85, 105, 0.95);
    }

    .browser-ocr-toast {
      position: fixed;
      right: 14px;
      bottom: 14px;
      background: #0f172a;
      color: #f8fafc;
      font-size: 12px;
      padding: 9px 12px;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      box-shadow: 0 16px 32px rgba(2, 6, 23, 0.45);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
      z-index: 2147483647;
      max-width: min(86vw, 520px);
    }

    .browser-ocr-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  `;

  document.documentElement.appendChild(style);
}

function showToast(text) {
  ensureRoot();

  if (!state.toast || !state.root.contains(state.toast)) {
    state.toast = document.createElement("div");
    state.toast.className = "browser-ocr-toast";
    state.root.appendChild(state.toast);
  }

  state.toast.textContent = text;
  state.toast.classList.add("show");

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    state.toast?.classList.remove("show");
  }, 2800);
}

showToast.timer = null;

async function getOcrWorker() {
  if (state.ocrWorker) {
    return state.ocrWorker;
  }

  if (state.ocrWorkerPromise) {
    state.ocrWorker = await state.ocrWorkerPromise;
    return state.ocrWorker;
  }

  if (!window.Tesseract || typeof window.Tesseract.createWorker !== "function") {
    throw new Error("Tesseract engine was not loaded.");
  }

  const workerPath = chrome.runtime.getURL("src/vendor/worker.min.js");
  const corePath = chrome.runtime.getURL("src/vendor");

  showToast("Loading OCR language model (first run may take longer)...");

  state.ocrWorkerPromise = window.Tesseract
    .createWorker("eng", 1, {
      workerPath,
      corePath,
      langPath: "https://tessdata.projectnaptha.com/4.0.0",
      logger: handleOcrLogger,
      errorHandler: (error) => {
        console.error("OCR worker error:", error);
      }
    })
    .then(async (worker) => {
      await worker.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
        tessedit_pageseg_mode: window.Tesseract.PSM.SPARSE_TEXT
      });
      state.ocrLanguageProfile = "eng";
      return worker;
    })
    .catch((error) => {
      state.ocrWorkerPromise = null;
      throw error;
    });

  state.ocrWorker = await state.ocrWorkerPromise;
  return state.ocrWorker;
}

async function ensureOcrLanguages(worker, languageProfile) {
  if (!worker || !languageProfile || state.ocrLanguageProfile === languageProfile) {
    return;
  }

  await worker.reinitialize(languageProfile, 1);
  await worker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
    tessedit_pageseg_mode: window.Tesseract.PSM.SPARSE_TEXT
  });
  state.ocrLanguageProfile = languageProfile;
}

function handleOcrLogger(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.status === "recognizing text" && typeof message.progress === "number") {
    const percent = Math.max(0, Math.min(100, Math.round(message.progress * 100)));
    const step = Math.floor(percent / 10);

    if (step !== state.ocrProgressStep) {
      state.ocrProgressStep = step;
      showToast(`Reading image text... ${percent}%`);
    }
    return;
  }

  if (typeof message.status === "string" && message.status.includes("loading") && typeof message.progress === "number") {
    const percent = Math.max(0, Math.min(100, Math.round(message.progress * 100)));
    const step = Math.floor(percent / 20);

    if (step !== state.ocrProgressStep) {
      state.ocrProgressStep = step;
      showToast(`${titleCase(message.status)} ${percent}%`);
    }
  }
}

function titleCase(value) {
  return value
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode screenshot image."));
    image.src = dataUrl;
  });
}

async function copyText(text) {
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.style.position = "fixed";
    temp.style.top = "-9999px";
    document.body.appendChild(temp);
    temp.focus();
    temp.select();
    document.execCommand("copy");
    temp.remove();
  }
}

function buildPrompt(text) {
  return `Please help me with this text from a webpage:\n\n${text}`;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // ignore stringify errors
  }

  return String(error);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

window.addEventListener("beforeunload", async () => {
  if (state.ocrWorker) {
    try {
      await state.ocrWorker.terminate();
    } catch {
      // Ignore teardown issues on unload.
    }
  }
});








