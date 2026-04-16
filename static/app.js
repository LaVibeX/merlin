const state = {
  currentFile: "",
  pdfs: [],
  pages: [],
  bionicReading: false,
  focusModeEnabled: false,
  splitViewerRatio: 0.55,
  isResizingSplit: false,
  currentMode: "server",
  localFiles: new Map(),
  currentObjectUrl: "",
  speechSessionId: 0,
  currentReadingLine: null,
  annotations: {
    notes: "",
    highlights: [],
    comments: [],
  },
  selectedLine: null,
  toastTimer: null,
};

const el = {
  folderInput: document.getElementById("folderInput"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  pdfList: document.getElementById("pdfList"),
  activePaper: document.getElementById("activePaper"),
  pdfFrame: document.getElementById("pdfFrame"),
  paperText: document.getElementById("paperText"),
  notesInput: document.getElementById("notesInput"),
  commentInput: document.getElementById("commentInput"),
  addCommentBtn: document.getElementById("addCommentBtn"),
  commentList: document.getElementById("commentList"),
  expandPdfBtn: document.getElementById("expandPdfBtn"),
  expandTextBtn: document.getElementById("expandTextBtn"),
  toggleSidebarBtn: document.getElementById("toggleSidebarBtn"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  bionicToggleBtn: document.getElementById("bionicToggleBtn"),
  speedSelect: document.getElementById("speedSelect"),
  viewerPanel: document.getElementById("viewerPanel"),
  textReaderPanel: document.getElementById("textReaderPanel"),
  readBtn: document.getElementById("readBtn"),
  stopReadBtn: document.getElementById("stopReadBtn"),
  saveBtn: document.getElementById("saveBtn"),
  splitToggleBtn: document.getElementById("splitToggleBtn"),
  focusExitBtn: document.getElementById("focusExitBtn"),
  splitDivider: document.getElementById("splitDivider"),
  splitGrid: document.querySelector(".grid"),
  selectedLineHint: document.getElementById("selectedLineHint"),
  toast: document.getElementById("toast"),
};

const SPLIT_RATIO_KEY = "merlin-split-view-ratio";
const FOCUS_MODE_KEY = "merlin-focus-mode-enabled";
const SPLIT_MIN_RATIO = 0.3;
const SPLIT_MAX_RATIO = 0.7;
const SPLIT_HANDLE_WIDTH = 12;
const SPLIT_PANE_MIN_WIDTH = 240;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");

  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }

  state.toastTimer = setTimeout(() => {
    el.toast.classList.remove("visible");
  }, 1800);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function highlightKey(page, line) {
  return `${page}:${line}`;
}

function currentHighlightSet() {
  const keys = state.annotations.highlights.map((h) => highlightKey(h.page, h.line));
  return new Set(keys);
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function loadFolder() {
  try {
    const data = await api("/api/folder");
    el.folderInput.value = data.folder || "";
    if (data.folder) {
      await loadPdfList();
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function collectPdfFiles(directoryHandle, prefix = "") {
  const found = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".pdf")) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      state.localFiles.set(relativePath, handle);
      found.push(relativePath);
      continue;
    }

    if (handle.kind === "directory") {
      const nextPrefix = prefix ? `${prefix}/${name}` : name;
      const nested = await collectPdfFiles(handle, nextPrefix);
      found.push(...nested);
    }
  }

  return found;
}

async function pickFolder() {
  if (!("showDirectoryPicker" in window)) {
    showToast("Browser directory picker is not supported here.");
    return;
  }

  try {
    const directoryHandle = await window.showDirectoryPicker({ mode: "read" });
    if (!directoryHandle) {
      showToast("Folder selection cancelled.");
      return;
    }

    state.currentMode = "browser";
    state.localFiles.clear();
    state.pdfs = (await collectPdfFiles(directoryHandle)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    el.folderInput.value = directoryHandle.name || "Browser selected folder";

    if (state.pdfs.length) {
      await openPdf(state.pdfs[0]);
    } else {
      state.currentFile = "";
      resetReaderPanels();
      renderPdfList();
    }

    showToast("Folder linked.");
  } catch (err) {
    if (err.name === "AbortError") {
      showToast("Folder selection cancelled.");
      return;
    }
    showToast(err.message || "Unable to pick folder.");
  }
}

function annotationKeyFor(file) {
  return `${state.currentMode}:${file}`;
}

async function getTextFromUpload(fileHandle) {
  const pickedFile = await fileHandle.getFile();
  const formData = new FormData();
  formData.append("file", pickedFile, pickedFile.name);
  return api("/api/text-upload", { method: "POST", body: formData });
}

function renderPdfList() {
  el.pdfList.innerHTML = "";

  if (state.pdfs.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No PDFs found in this folder.";
    el.pdfList.appendChild(item);
    return;
  }

  for (const file of state.pdfs) {
    const item = document.createElement("li");
    item.textContent = file;
    if (file === state.currentFile) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => openPdf(file));
    el.pdfList.appendChild(item);
  }
}

async function loadPdfList() {
  try {
    const data = await api("/api/pdfs");
    state.pdfs = (data.files || []).filter(
      (file) => typeof file === "string" && file.toLowerCase().endsWith(".pdf"),
    );

    if (state.currentFile && state.pdfs.includes(state.currentFile)) {
      renderPdfList();
    } else if (state.pdfs.length) {
      openPdf(state.pdfs[0]);
    } else {
      state.currentFile = "";
      resetReaderPanels();
      renderPdfList();
    }
  } catch (err) {
    state.pdfs = [];
    state.currentFile = "";
    resetReaderPanels();
    renderPdfList();
    showToast(err.message);
  }
}

function resetReaderPanels() {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = "";
  }

  state.speechSessionId += 1;
  speechSynthesis.cancel();
  clearReadingLineUI();

  el.activePaper.textContent = "No paper selected";
  el.pdfFrame.src = "";
  el.paperText.innerHTML = "";
  el.notesInput.value = "";
  el.commentList.innerHTML = "";
  state.pages = [];
  state.annotations = { notes: "", highlights: [], comments: [] };
  state.selectedLine = null;
  el.selectedLineHint.textContent = "Select a line in the text panel first.";
}

function updateSplitToggleLabel() {
  const label = state.focusModeEnabled ? "Exit Focus View" : "Focus Split View";
  el.splitToggleBtn.setAttribute("aria-label", label);
  el.splitToggleBtn.setAttribute("title", label);
  el.splitToggleBtn.classList.toggle("is-active", state.focusModeEnabled);
}

function applySplitWidthsFromRatio() {
  if (!state.focusModeEnabled || !el.splitGrid) {
    return;
  }

  const gridRect = el.splitGrid.getBoundingClientRect();
  if (!gridRect.width) {
    return;
  }

  const availableWidth = gridRect.width - SPLIT_HANDLE_WIDTH;
  if (availableWidth < SPLIT_PANE_MIN_WIDTH * 2) {
    return;
  }

  const viewerWidth = clamp(
    Math.round(availableWidth * state.splitViewerRatio),
    SPLIT_PANE_MIN_WIDTH,
    Math.max(SPLIT_PANE_MIN_WIDTH, availableWidth - SPLIT_PANE_MIN_WIDTH),
  );
  const textWidth = Math.max(SPLIT_PANE_MIN_WIDTH, availableWidth - viewerWidth);

  el.splitGrid.style.setProperty("--split-viewer-width", `${viewerWidth}px`);
  el.splitGrid.style.setProperty("--split-text-width", `${textWidth}px`);
}

function setFocusModeEnabled(enabled) {
  state.focusModeEnabled = enabled;
  document.body.classList.toggle("focus-reader", enabled);
  localStorage.setItem(FOCUS_MODE_KEY, enabled ? "true" : "false");
  updateSplitToggleLabel();

  if (enabled) {
    applySplitWidthsFromRatio();
  } else {
    if (el.splitGrid) {
      el.splitGrid.style.removeProperty("--split-viewer-width");
      el.splitGrid.style.removeProperty("--split-text-width");
    }
  }
}

function setSplitRatioFromClientX(clientX) {
  if (!el.splitGrid || window.matchMedia("(max-width: 1100px)").matches) {
    return;
  }

  const gridRect = el.splitGrid.getBoundingClientRect();
  const availableWidth = gridRect.width - SPLIT_HANDLE_WIDTH;
  if (availableWidth <= 0) {
    return;
  }

  const relativeX = clamp(
    clientX - gridRect.left - SPLIT_HANDLE_WIDTH / 2,
    SPLIT_PANE_MIN_WIDTH,
    availableWidth - SPLIT_PANE_MIN_WIDTH,
  );
  const ratio = clamp(relativeX / availableWidth, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO);
  state.splitViewerRatio = ratio;
  localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  applySplitWidthsFromRatio();
}

function toggleSplitView() {
  setFocusModeEnabled(!state.focusModeEnabled);
  showToast(state.focusModeEnabled ? "Focus split view enabled." : "Focus split view disabled.");
}

function beginSplitResize(event) {
  if (event.button !== 0 || window.matchMedia("(max-width: 1100px)").matches) {
    return;
  }

  event.preventDefault();
  state.isResizingSplit = true;
  document.body.classList.add("resizing-split");

  const stopResize = () => {
    state.isResizingSplit = false;
    document.body.classList.remove("resizing-split");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
  };

  const onMove = (moveEvent) => {
    if (!state.isResizingSplit) {
      return;
    }
    setSplitRatioFromClientX(moveEvent.clientX);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stopResize, { once: true });
  window.addEventListener("pointercancel", stopResize, { once: true });
  setSplitRatioFromClientX(event.clientX);
}

function renderTextPanel() {
  el.paperText.innerHTML = "";
  const highlightSet = currentHighlightSet();

  for (const page of state.pages) {
    const heading = document.createElement("p");
    heading.className = "page-title";
    heading.textContent = `Page ${page.page}`;
    el.paperText.appendChild(heading);

    if (!page.lines.length) {
      const empty = document.createElement("p");
      empty.className = "text-line";
      empty.textContent = "(No extractable text on this page)";
      el.paperText.appendChild(empty);
      continue;
    }

    page.lines.forEach((lineText, index) => {
      const lineNumber = index + 1;
      const row = document.createElement("div");
      row.className = "text-line";
      row.dataset.page = String(page.page);
      row.dataset.line = String(lineNumber);
      row.dataset.text = lineText;
      applyLineDisplay(row, lineText);

      const key = highlightKey(page.page, lineNumber);
      if (highlightSet.has(key)) {
        row.classList.add("highlighted");
      }

      if (
        state.selectedLine &&
        Number(state.selectedLine.page) === Number(page.page) &&
        Number(state.selectedLine.line) === lineNumber
      ) {
        row.classList.add("selected");
      }

      if (
        state.currentReadingLine &&
        Number(state.currentReadingLine.page) === Number(page.page) &&
        Number(state.currentReadingLine.line) === lineNumber
      ) {
        row.classList.add("reading");
      }

      row.addEventListener("click", () => {
        selectLine(page.page, lineNumber, lineText, row);
      });

      el.paperText.appendChild(row);
    });
  }
}

function renderComments() {
  el.commentList.innerHTML = "";
  const comments = state.annotations.comments || [];

  if (!comments.length) {
    const item = document.createElement("li");
    item.textContent = "No comments yet.";
    el.commentList.appendChild(item);
    return;
  }

  for (const comment of comments) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>Page ${comment.page}, line ${comment.line}</strong><br>${comment.comment}`;
    el.commentList.appendChild(item);
  }
}

function clearSelectedUI() {
  document.querySelectorAll(".text-line.selected").forEach((node) => {
    node.classList.remove("selected");
  });
}

function clearReadingLineUI() {
  document.querySelectorAll(".text-line.reading").forEach((node) => {
    node.classList.remove("reading");
  });
  state.currentReadingLine = null;
}

function setReadingLine(page, line) {
  if (
    state.currentReadingLine &&
    Number(state.currentReadingLine.page) === Number(page) &&
    Number(state.currentReadingLine.line) === Number(line)
  ) {
    return;
  }

  clearReadingLineUI();
  state.currentReadingLine = { page, line };

  const node = document.querySelector(`.text-line[data-page='${page}'][data-line='${line}']`);
  if (!node) {
    return;
  }

  node.classList.add("reading");
  node.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function selectLine(page, line, text, node) {
  clearSelectedUI();
  node.classList.add("selected");

  state.selectedLine = { page, line, text };
  el.selectedLineHint.textContent = `Selected: page ${page}, line ${line}`;

  const key = highlightKey(page, line);
  const highlightIndex = state.annotations.highlights.findIndex(
    (entry) => Number(entry.page) === Number(page) && Number(entry.line) === Number(line),
  );

  if (highlightIndex >= 0) {
    state.annotations.highlights.splice(highlightIndex, 1);
    node.classList.remove("highlighted");
  } else {
    state.annotations.highlights.push({
      id: crypto.randomUUID(),
      page,
      line,
      text,
      createdAt: new Date().toISOString(),
    });
    node.classList.add("highlighted");
  }
}

async function openPdf(file) {
  state.speechSessionId += 1;
  speechSynthesis.cancel();
  clearReadingLineUI();

  state.currentFile = file;
  el.activePaper.textContent = file;

  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = "";
  }

  renderPdfList();

  try {
    let textPromise;
    if (state.currentMode === "browser") {
      const fileHandle = state.localFiles.get(file);
      if (!fileHandle) {
        throw new Error("The selected file is no longer available.");
      }

      const localFile = await fileHandle.getFile();
      state.currentObjectUrl = URL.createObjectURL(localFile);
      el.pdfFrame.src = state.currentObjectUrl;
      textPromise = getTextFromUpload(fileHandle);
    } else {
      el.pdfFrame.src = `/api/pdf?file=${encodeURIComponent(file)}`;
      textPromise = api(`/api/text?file=${encodeURIComponent(file)}`);
    }

    const [textData, annotationData] = await Promise.all([
      textPromise,
      api(`/api/annotations?file=${encodeURIComponent(annotationKeyFor(file))}`),
    ]);

    state.pages = textData.pages || [];
    state.annotations = {
      notes: annotationData.notes || "",
      highlights: annotationData.highlights || [],
      comments: annotationData.comments || [],
    };

    state.selectedLine = null;
    el.notesInput.value = state.annotations.notes;
    el.commentInput.value = "";
    el.selectedLineHint.textContent = "Select a line in the text panel first.";
    renderTextPanel();
    renderComments();
  } catch (err) {
    showToast(err.message);
  }
}

function addComment() {
  if (!state.selectedLine) {
    showToast("Pick a line first.");
    return;
  }

  const commentText = el.commentInput.value.trim();
  if (!commentText) {
    showToast("Write a comment first.");
    return;
  }

  state.annotations.comments.push({
    id: crypto.randomUUID(),
    page: state.selectedLine.page,
    line: state.selectedLine.line,
    text: state.selectedLine.text,
    comment: commentText,
    createdAt: new Date().toISOString(),
  });

  el.commentInput.value = "";
  renderComments();
  showToast("Comment added.");
}

async function saveAnnotations() {
  if (!state.currentFile) {
    showToast("Open a paper first.");
    return;
  }

  state.annotations.notes = el.notesInput.value;

  try {
    await api(`/api/annotations?file=${encodeURIComponent(annotationKeyFor(state.currentFile))}`, {
      method: "PUT",
      body: JSON.stringify(state.annotations),
    });
    showToast("Annotations saved.");
  } catch (err) {
    showToast(err.message);
  }
}

function splitSpeechText(text, maxChunkLength = 900) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^.!?]+[.!?]*/g) || [normalized];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChunkLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trim());
      current = "";
    }

    if (sentence.length <= maxChunkLength) {
      current = sentence;
      continue;
    }

    for (let start = 0; start < sentence.length; start += maxChunkLength) {
      chunks.push(sentence.slice(start, start + maxChunkLength).trim());
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

function getEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) {
    return null;
  }

  const normalizedVoices = voices.map((voice) => ({
    voice,
    name: (voice.name || "").toLowerCase(),
    lang: (voice.lang || "").toLowerCase(),
  }));

  // Prefer Chrome's natural-sounding Google US English voice when present.
  const preferred =
    normalizedVoices.find((entry) => entry.name === "google us english 4") ||
    normalizedVoices.find((entry) => entry.name.includes("google us english 4")) ||
    normalizedVoices.find(
      (entry) => entry.name.includes("google") && entry.lang.startsWith("en-us"),
    ) ||
    normalizedVoices.find((entry) => entry.lang.startsWith("en-us")) ||
    normalizedVoices.find((entry) => entry.lang.startsWith("en"));

  return preferred ? preferred.voice : null;
}

function buildSpeechLineQueue() {
  let startPage = null;
  let startLine = null;
  if (state.selectedLine) {
    startPage = Number(state.selectedLine.page);
    startLine = Number(state.selectedLine.line);
  }

  const queue = [];
  let readingStarted = startPage === null;
  const sentenceEndPattern = /[.!?]["')\]]*$/;
  let sentenceBuffer = [];
  let sentenceLineRefs = [];
  let sentenceStart = null;

  const flushSentence = () => {
    if (!sentenceBuffer.length || !sentenceStart) {
      return;
    }

    const sentenceText = sentenceBuffer.join(" ").replace(/\s+/g, " ").trim();
    if (sentenceText) {
      const lineRanges = [];
      let cursor = 0;

      for (let lineIdx = 0; lineIdx < sentenceBuffer.length; lineIdx += 1) {
        const lineText = String(sentenceBuffer[lineIdx] || "").replace(/\s+/g, " ").trim();
        if (!lineText) {
          continue;
        }

        const lineRef = sentenceLineRefs[lineIdx] || sentenceStart;
        const start = cursor;
        const end = start + lineText.length;
        lineRanges.push({ page: lineRef.page, line: lineRef.line, start, end });
        cursor = end + 1;
      }

      const chunks = splitSpeechText(sentenceText);
      let chunkSearchStart = 0;

      for (let idx = 0; idx < chunks.length; idx += 1) {
        const chunkText = chunks[idx];
        const foundAt = sentenceText.indexOf(chunkText, chunkSearchStart);
        const chunkStart = foundAt >= 0 ? foundAt : chunkSearchStart;
        chunkSearchStart = chunkStart + chunkText.length;

        let anchor = sentenceStart;
        for (const range of lineRanges) {
          if (chunkStart >= range.start) {
            anchor = { page: range.page, line: range.line };
            continue;
          }
          break;
        }

        queue.push({
          page: anchor.page,
          line: anchor.line,
          text: chunkText,
          chunkStart,
          lineRanges,
        });
      }
    }

    sentenceBuffer = [];
    sentenceLineRefs = [];
    sentenceStart = null;
  };

  for (const page of state.pages) {
    const pageNumber = Number(page.page);
    const pageLines = Array.isArray(page.lines) ? page.lines : [];

    for (let idx = 0; idx < pageLines.length; idx += 1) {
      const lineNumber = idx + 1;

      if (!readingStarted) {
        if (pageNumber < startPage) {
          continue;
        }
        if (pageNumber === startPage && lineNumber < startLine) {
          continue;
        }
        readingStarted = true;
      }

      const text = String(pageLines[idx] || "").trim();
      if (!text) {
        continue;
      }

      if (!sentenceStart) {
        sentenceStart = { page: pageNumber, line: lineNumber };
      }

      sentenceBuffer.push(text);
      sentenceLineRefs.push({ page: pageNumber, line: lineNumber });
      if (sentenceEndPattern.test(text)) {
        flushSentence();
      }
    }
  }

  flushSentence();

  return queue;
}

function getReadingRate() {
  const rawValue = Number.parseFloat(el.speedSelect.value);
  if (Number.isNaN(rawValue)) {
    return 1.25;
  }
  return Math.min(Math.max(rawValue, 0.5), 2);
}

function readAloud() {
  if (!state.pages.length) {
    showToast("No text available to read.");
    return;
  }

  const speechQueue = buildSpeechLineQueue();
  if (!speechQueue.length) {
    showToast("This PDF has no extractable text.");
    return;
  }

  state.speechSessionId += 1;
  const currentSession = state.speechSessionId;
  speechSynthesis.cancel();
  clearReadingLineUI();

  const englishVoice = getEnglishVoice();
  const readingRate = getReadingRate();
  let started = false;

  for (let i = 0; i < speechQueue.length; i += 1) {
    const entry = speechQueue[i];
    const utterance = new SpeechSynthesisUtterance(entry.text);
    utterance.lang = "en-US";
    if (englishVoice) {
      utterance.voice = englishVoice;
    }
    utterance.rate = readingRate;
    utterance.pitch = 1;

    utterance.onstart = () => {
      if (currentSession !== state.speechSessionId) {
        return;
      }

      setReadingLine(entry.page, entry.line);
      if (!started) {
        started = true;
        if (state.selectedLine) {
          showToast(`Reading started from page ${state.selectedLine.page}, line ${state.selectedLine.line}.`);
        } else {
          showToast("Reading started.");
        }
      }
    };

    utterance.onboundary = (event) => {
      if (currentSession !== state.speechSessionId) {
        return;
      }

      if (typeof event.charIndex !== "number" || !Array.isArray(entry.lineRanges)) {
        return;
      }

      const absoluteIndex = Math.max(0, Number(entry.chunkStart || 0) + event.charIndex);
      let activeLine = null;

      for (const range of entry.lineRanges) {
        if (absoluteIndex >= range.start) {
          activeLine = range;
          continue;
        }
        break;
      }

      if (activeLine) {
        setReadingLine(activeLine.page, activeLine.line);
      }
    };

    utterance.onend = () => {
      if (currentSession !== state.speechSessionId) {
        return;
      }

      if (i === speechQueue.length - 1) {
        clearReadingLineUI();
      }
    };

    utterance.onerror = () => {
      if (currentSession !== state.speechSessionId) {
        return;
      }
      showToast("Could not continue audio reading.");
      clearReadingLineUI();
    };

    speechSynthesis.speak(utterance);
  }

  window.setTimeout(() => {
    if (!started && !speechSynthesis.speaking && !speechSynthesis.pending) {
      showToast("No speech voice available in this browser.");
    }
  }, 1200);
}

function stopReading() {
  state.speechSessionId += 1;
  speechSynthesis.cancel();
  clearReadingLineUI();
  showToast("Reading stopped.");
}

function applyTheme(themeName) {
  const darkModeEnabled = themeName === "dark";
  document.body.classList.toggle("dark-mode", darkModeEnabled);
  el.themeToggleBtn.textContent = darkModeEnabled ? "Light Mode" : "Dark Mode";
}

function updateBionicButtonLabel() {
  el.bionicToggleBtn.textContent = state.bionicReading ? "Bionic: On" : "Bionic: Off";
  el.paperText.classList.toggle("bionic-on", state.bionicReading);
}

function applyLineDisplay(row, lineText) {
  if (!state.bionicReading) {
    row.textContent = lineText;
    return;
  }

  row.textContent = "";
  const tokens = String(lineText).split(/(\s+)/);

  for (const token of tokens) {
    if (!token) {
      continue;
    }

    if (/^\s+$/.test(token)) {
      row.appendChild(document.createTextNode(token));
      continue;
    }

    const pivot = Math.max(1, Math.ceil(token.length * 0.4));
    const strong = document.createElement("strong");
    strong.textContent = token.slice(0, pivot);
    row.appendChild(strong);
    row.appendChild(document.createTextNode(token.slice(pivot)));
  }
}

function toggleBionicReading() {
  state.bionicReading = !state.bionicReading;
  updateBionicButtonLabel();
  renderTextPanel();
}

function toggleTheme() {
  const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
  applyTheme(nextTheme);
  localStorage.setItem("merlin-theme", nextTheme);
}

function updateSidebarToggleLabel() {
  const isCollapsed = document.body.classList.contains("sidebar-collapsed");
  const label = isCollapsed ? "Show Folder" : "Hide Folder";
  el.toggleSidebarBtn.setAttribute("aria-label", label);
  el.toggleSidebarBtn.setAttribute("title", label);
  el.toggleSidebarBtn.classList.toggle("is-collapsed", isCollapsed);
}

function toggleSidebarView() {
  document.body.classList.toggle("sidebar-collapsed");
  updateSidebarToggleLabel();
}

function updateExpandButtonLabel() {
  const isFullscreen = document.fullscreenElement === el.viewerPanel;
  const label = isFullscreen ? "Exit Fullscreen" : "Expand PDF";
  el.expandPdfBtn.setAttribute("aria-label", label);
  el.expandPdfBtn.setAttribute("title", label);
}

function updateExpandTextButtonLabel() {
  const isFullscreen = document.fullscreenElement === el.textReaderPanel;
  const label = isFullscreen ? "Exit Fullscreen" : "Expand Extracted Text";
  el.expandTextBtn.setAttribute("aria-label", label);
  el.expandTextBtn.setAttribute("title", label);
}

async function togglePdfFullscreen() {
  if (!el.pdfFrame.src) {
    showToast("Open a paper first.");
    return;
  }

  try {
    if (document.fullscreenElement === el.viewerPanel) {
      await document.exitFullscreen();
      return;
    }

    await el.viewerPanel.requestFullscreen();
  } catch (err) {
    showToast(err.message || "Fullscreen is not available.");
  }
}

async function toggleTextFullscreen() {
  if (!state.pages.length) {
    showToast("Open a paper first.");
    return;
  }

  try {
    if (document.fullscreenElement === el.textReaderPanel) {
      await document.exitFullscreen();
      return;
    }

    await el.textReaderPanel.requestFullscreen();
  } catch (err) {
    showToast(err.message || "Fullscreen is not available.");
  }
}

function bindEvents() {
  el.pickFolderBtn.addEventListener("click", pickFolder);
  el.refreshBtn.addEventListener("click", () => {
    if (state.currentMode === "browser") {
      showToast("Choose folder again to refresh browser-selected files.");
      return;
    }
    loadPdfList();
  });
  el.addCommentBtn.addEventListener("click", addComment);
  el.saveBtn.addEventListener("click", saveAnnotations);
  el.splitToggleBtn.addEventListener("click", toggleSplitView);
  el.focusExitBtn.addEventListener("click", toggleSplitView);
  el.splitDivider.addEventListener("pointerdown", beginSplitResize);
  el.toggleSidebarBtn.addEventListener("click", toggleSidebarView);
  el.themeToggleBtn.addEventListener("click", toggleTheme);
  el.bionicToggleBtn.addEventListener("click", toggleBionicReading);
  el.speedSelect.addEventListener("change", () => {
    showToast(`Reading speed set to ${el.speedSelect.value}x.`);
  });
  el.expandPdfBtn.addEventListener("click", togglePdfFullscreen);
  el.expandTextBtn.addEventListener("click", toggleTextFullscreen);
  document.addEventListener("fullscreenchange", () => {
    updateExpandButtonLabel();
    updateExpandTextButtonLabel();
  });
  el.readBtn.addEventListener("click", readAloud);
  el.stopReadBtn.addEventListener("click", stopReading);
}

bindEvents();
window.addEventListener("resize", () => {
  applySplitWidthsFromRatio();
});
if ("onvoiceschanged" in speechSynthesis) {
  speechSynthesis.onvoiceschanged = () => {
    getEnglishVoice();
  };
}
const savedRatio = Number.parseFloat(localStorage.getItem(SPLIT_RATIO_KEY));
if (!Number.isNaN(savedRatio)) {
  state.splitViewerRatio = clamp(savedRatio, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO);
}
setFocusModeEnabled(localStorage.getItem(FOCUS_MODE_KEY) === "true");
applyTheme(localStorage.getItem("merlin-theme") || "light");
updateBionicButtonLabel();
updateSidebarToggleLabel();
updateExpandButtonLabel();
updateExpandTextButtonLabel();
loadFolder();
