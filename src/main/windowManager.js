// Creates and tracks one native window per section, plus the settings window.
//
// Memory model: every window is a real, independent BrowserWindow (so per-window
// position / transparency / desktop-pinning all keep working), but instead of
// each `new BrowserWindow` getting its OWN Chromium renderer process (~78 MB of
// fixed overhead apiece), we open them all via window.open() from one hidden
// "root" page. Same-origin window.open keeps the child in the OPENER's renderer
// process, so all cards + the settings window share ONE renderer instead of N.
// See src/renderer/root/root.html and openChild() below.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./store');
const desktopPin = require('./desktopPin');

const HEADER_H = 46;
const MIN_W = 180;
const MIN_H = 120;

const sectionWindows = new Map(); // id -> BrowserWindow (live, wired windows)
let settingsWindow = null;
let settingsOpening = false;
const movedTimers = new Map();

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const ROOT_HTML = path.join(__dirname, '..', 'renderer', 'root', 'root.html');
const SECTION_HTML = path.join(__dirname, '..', 'renderer', 'section', 'section.html');
const TODO_HTML = path.join(__dirname, '..', 'renderer', 'todo', 'todo.html');
const SETTINGS_HTML = path.join(__dirname, '..', 'renderer', 'settings', 'settings.html');

// ---------- shared renderer host ----------
// The hidden opener window whose single renderer process hosts every card.
let rootWin = null;
let rootLoaded = false;
let quitting = false;
const rootQueue = [];               // deferred opens, run once root has loaded
const pendingOpens = new Map();     // frameName -> { resolve, options }
const openingSections = new Map();   // sectionId -> frameName of the in-flight open
let frameSeq = 0;

function ensureRoot() {
  if (rootWin && !rootWin.isDestroyed()) return;
  rootWin = new BrowserWindow({
    width: 1, height: 1, x: -32000, y: -32000,
    show: false, frame: false, skipTaskbar: true, focusable: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });
  rootWin.setMenu(null);
  const wc = rootWin.webContents;

  // Every window.open() from the root funnels through here; we match the call
  // to its pending record by frameName and hand back that window's real options.
  wc.setWindowOpenHandler(({ frameName }) => {
    const rec = pendingOpens.get(frameName);
    if (!rec) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: rec.options };
  });
  wc.on('did-create-window', (child, details) => {
    const rec = pendingOpens.get(details.frameName);
    if (rec) { pendingOpens.delete(details.frameName); rec.resolve(child); }
  });
  wc.once('did-finish-load', () => {
    rootLoaded = true;
    const q = rootQueue.splice(0);
    for (const fn of q) fn();
  });
  // Shared process died → every card died with it. Rebuild from the store.
  wc.on('render-process-gone', () => { if (!quitting) scheduleRebuild(); });

  rootWin.loadFile(ROOT_HTML);
}

// Open a real BrowserWindow as a window.open() child of the shared root, so it
// lands in the root's renderer process. Resolves with the child BrowserWindow.
function openChild(url, frameName, options) {
  return new Promise((resolve) => {
    ensureRoot();
    const run = () => {
      if (!rootWin || rootWin.isDestroyed()) { resolve(null); return; }
      pendingOpens.set(frameName, { resolve, options });
      // userGesture=true so the open is never treated as a blocked popup.
      rootWin.webContents
        .executeJavaScript(`window.open(${JSON.stringify(url)}, ${JSON.stringify(frameName)}); 0;`, true)
        .catch(() => { pendingOpens.delete(frameName); resolve(null); });
    };
    if (rootLoaded && rootWin && !rootWin.isDestroyed()) run();
    else rootQueue.push(run);
  });
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildAll, 300);
}
function rebuildAll() {
  for (const win of sectionWindows.values()) { if (!win.isDestroyed()) win.destroy(); }
  sectionWindows.clear();
  openingSections.clear();
  pendingOpens.clear();
  rootQueue.length = 0;
  if (rootWin && !rootWin.isDestroyed()) rootWin.destroy();
  rootWin = null; rootLoaded = false;
  for (const s of store.listSections()) createSectionWindow(s);
}

function setQuitting() { quitting = true; }

function clampBounds(b) {
  const area = screen.getDisplayNearestPoint({ x: b.x || 0, y: b.y || 0 }).workArea;
  const width = Math.max(MIN_W, Math.round(b.width || 300));
  const height = Math.max(MIN_H, Math.round(b.height || 240));
  let x = Math.round(b.x); let y = Math.round(b.y);
  if (!Number.isFinite(x)) x = area.x + 80;
  if (!Number.isFinite(y)) y = area.y + 80;
  // Keep at least part of the card on a visible display.
  x = Math.min(Math.max(x, area.x - width + 60), area.x + area.width - 60);
  y = Math.min(Math.max(y, area.y), area.y + area.height - HEADER_H);
  return { x, y, width, height };
}

function createSectionWindow(section) {
  const id = section.id;
  if (sectionWindows.has(id)) return sectionWindows.get(id);
  const b = clampBounds(section.bounds);
  const html = section.type === 'todo' ? TODO_HTML : SECTION_HTML;
  // window.open() carries the id in the query string, exactly like the old
  // loadFile({ query }) did — the renderer reads it from location.search.
  const url = `${pathToFileURL(html).href}?id=${encodeURIComponent(id)}`;
  const options = {
    x: b.x, y: b.y, width: b.width, height: section.collapsed ? HEADER_H : b.height,
    minWidth: MIN_W, minHeight: HEADER_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,     // we drive resize via grips + setBounds
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'toolbar',      // keep out of Alt-Tab
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // These windows are never the foreground window; without this, Chromium
      // throttles/pauses their timers + rAF (breaks live resize & portal updates).
      backgroundThrottling: false,
    },
  };

  const frameName = `sec-${id}-${++frameSeq}`;
  openingSections.set(id, frameName);
  openChild(url, frameName, options).then((win) => {
    // A close/delete/reload during the async open supersedes this request
    // (the id's in-flight frameName changed or was cleared) — discard the window.
    if (!win || openingSections.get(id) !== frameName) {
      if (win && !win.isDestroyed()) win.destroy();
      return;
    }
    openingSections.delete(id);
    wireSectionWindow(win, section);
  });
  return null; // async now; every caller ignores the return value
}

// Attach all the per-section behaviour once the shared-process window exists.
function wireSectionWindow(win, section) {
  if (win.isDestroyed()) return;
  win.__sectionId = section.id;
  win.setMenu(null);

  // Reveal exactly once: show() raises it to front on launch, then pin it to
  // the desktop layer. ready-to-show is the normal trigger; the did-finish-load
  // fallback guarantees the card still appears if a window.open child ever
  // skips ready-to-show.
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    applyPin(win);
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 50));

  win.on('moved', () => scheduleMovedPersist(section.id, win));
  win.on('closed', () => sectionWindows.delete(section.id));
  sectionWindows.set(section.id, win);
}

function applyPin(win) {
  // Restore to the canonical stored size (position from the live window) so
  // embedding can never drift/shrink and even heals earlier drift.
  let desired = null;
  const s = win.__sectionId ? store.getSection(win.__sectionId) : null;
  if (s) {
    const live = win.getBounds();
    desired = {
      x: live.x, y: live.y,
      width: s.bounds.width,
      height: s.collapsed ? HEADER_H : s.bounds.height,
    };
  }
  desktopPin.pin(win, store.getSettings().embedInDesktop, desired);
}

function scheduleMovedPersist(id, win) {
  clearTimeout(movedTimers.get(id));
  movedTimers.set(id, setTimeout(() => {
    if (win.isDestroyed()) return;
    const s = store.getSection(id);
    if (!s) return;
    const wb = win.getBounds();
    const patch = { x: wb.x, y: wb.y, width: wb.width };
    if (!s.collapsed) patch.height = wb.height; // preserve expanded height while collapsed
    store.patchSection(id, { bounds: { ...s.bounds, ...patch } });
    pushState(id);
  }, 140));
}

// State the renderer needs, with live x/y merged in.
function liveState(id) {
  const s = store.getSection(id);
  if (!s) return null;
  const win = sectionWindows.get(id);
  if (win && !win.isDestroyed()) {
    const wb = win.getBounds();
    return { ...s, bounds: { ...s.bounds, x: wb.x, y: wb.y, width: wb.width } };
  }
  return s;
}

function pushState(id) {
  send(id, 'section:state', liveState(id));
}

function send(id, channel, payload) {
  const win = sectionWindows.get(id);
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  for (const win of sectionWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function getWindow(id) { return sectionWindows.get(id); }

// Bring a section's window to the foreground (used when a reminder toast is
// clicked, so the list is visible even if it was hidden behind other apps).
function focusSection(id) {
  const win = sectionWindows.get(id);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function getBounds(id) {
  const win = sectionWindows.get(id);
  return win && !win.isDestroyed() ? win.getBounds() : null;
}

const boundsPersistTimers = new Map();
function setBoundsFromRenderer(id, bounds) {
  const win = sectionWindows.get(id);
  const s = store.getSection(id);
  if (!win || win.isDestroyed() || !s) return;
  const width = Math.max(MIN_W, Math.round(bounds.width));
  const height = Math.max(MIN_H, Math.round(bounds.height));
  const x = Math.round(bounds.x); const y = Math.round(bounds.y);
  win.setBounds({ x, y, width, height }); // apply live every move (smooth)
  // Persist to disk only after the drag settles, so we don't write on every frame.
  clearTimeout(boundsPersistTimers.get(id));
  boundsPersistTimers.set(id, setTimeout(() => {
    if (!win.isDestroyed()) store.patchSection(id, { bounds: { x, y, width, height } });
  }, 220));
}

function setCollapsed(id, collapsed) {
  const s = store.patchSection(id, { collapsed });
  const win = sectionWindows.get(id);
  if (win && !win.isDestroyed() && s) {
    const wb = win.getBounds();
    win.setBounds({ x: wb.x, y: wb.y, width: s.bounds.width, height: collapsed ? HEADER_H : s.bounds.height });
  }
  pushState(id);
  return s;
}

function closeSectionWindow(id) {
  const win = sectionWindows.get(id);
  if (win && !win.isDestroyed()) win.close();
  sectionWindows.delete(id);
  // If a window for this id is still opening in the shared process, mark the
  // request superseded so it's destroyed the moment it resolves (no leak).
  openingSections.delete(id);
}

function setVisibleAll(visible) {
  for (const win of sectionWindows.values()) {
    if (win.isDestroyed()) continue;
    if (visible) { win.show(); applyPin(win); } // show() raises to front so "Show all" reveals them
    else win.hide();
  }
}

function reapplyPinAll() {
  for (const win of sectionWindows.values()) {
    if (!win.isDestroyed()) applyPin(win);
  }
}

function hasWindows() { return sectionWindows.size > 0; }
function allIds() { return [...sectionWindows.keys()]; }

// ---------- settings window ----------
// Opened through the same shared renderer as the cards (window.open from root),
// so it costs no extra process. Async now — callers already ignore the return.
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  if (settingsOpening) return null; // an open is already in flight
  settingsOpening = true;

  const url = pathToFileURL(SETTINGS_HTML).href;
  const options = {
    width: 560, height: 720, minWidth: 460, minHeight: 520,
    frame: false,
    transparent: false,
    backgroundColor: '#12141b',
    resizable: true,
    skipTaskbar: false,
    show: false,
    title: 'Desktop Organizer — Settings',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  openChild(url, `settings-${++frameSeq}`, options).then((win) => {
    settingsOpening = false;
    if (!win) return;
    settingsWindow = win;
    settingsWindow.setMenu(null);
    settingsWindow.once('ready-to-show', () => { settingsWindow.show(); settingsWindow.focus(); });
    settingsWindow.webContents.once('did-finish-load', () => setTimeout(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); }
    }, 50));
    settingsWindow.on('closed', () => { settingsWindow = null; });
  });
  return null;
}

module.exports = {
  HEADER_H,
  createSectionWindow, closeSectionWindow, getWindow, getBounds, focusSection,
  pushState, send, broadcast, liveState,
  setBoundsFromRenderer, setCollapsed,
  setVisibleAll, reapplyPinAll,
  hasWindows, allIds,
  openSettingsWindow,
  setQuitting,
};
