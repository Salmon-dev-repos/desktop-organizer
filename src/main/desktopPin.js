// Keeps section windows behaving like desktop widgets.
//
// Two strategies, both optional (require koffi + user32; if anything fails the
// app still runs as ordinary frameless widgets):
//   • "embed"    -> SetParent(section, WorkerW) so cards live on the wallpaper
//                   layer and survive Win+D (Rainmeter/Wallpaper-Engine trick).
//                   Advanced & machine-dependent; auto-falls back to floating.
//   • "floating" -> keep the window at the bottom of the z-order so it never
//                   covers your active apps (rock-solid, the default).
let koffi = null;
let user32 = null;
let loaded = false;
let fns = null;
let EnumProc = null;
let cachedWorker = null;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const HWND_BOTTOM = 1;
const SMTO_ABORTIFHUNG = 0x0002;

function init() {
  if (loaded) return true;
  if (process.platform !== 'win32') return false;
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    fns = {
      FindWindowW: user32.func('uintptr FindWindowW(str16, str16)'),
      FindWindowExW: user32.func('uintptr FindWindowExW(uintptr, uintptr, str16, str16)'),
      SendMessageTimeoutW: user32.func(
        'intptr SendMessageTimeoutW(uintptr, uint, uintptr, intptr, uint, uint, void*)'
      ),
      EnumWindows: user32.func('bool EnumWindows(void*, intptr)'),
      SetParent: user32.func('uintptr SetParent(uintptr, uintptr)'),
      SetWindowPos: user32.func('bool SetWindowPos(uintptr, uintptr, int, int, int, int, uint)'),
      SendMessageW: user32.func('intptr SendMessageW(uintptr, uint, uintptr, intptr)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(uintptr)'),
    };
    EnumProc = koffi.proto('bool EnumWindowsProc(uintptr, intptr)');
    loaded = true;
    return true;
  } catch (e) {
    console.warn('[desktopPin] native pinning unavailable:', e.message);
    loaded = false;
    return false;
  }
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  // 64-bit HWND on x64 Windows.
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function nonZero(h) { return h !== null && h !== undefined && h !== 0 && h !== 0n; }

// Locate the WorkerW window that sits behind the desktop icons.
function findWorkerW() {
  const progman = fns.FindWindowW('Progman', null);
  // Ask Progman to spawn the WorkerW layer (ignore result).
  try {
    fns.SendMessageTimeoutW(progman, 0x052c, 0, 0, SMTO_ABORTIFHUNG, 1000, Buffer.alloc(8));
  } catch (_) { /* ignore */ }

  let worker = 0n;
  const cb = koffi.register((top /*, lparam */) => {
    try {
      const shell = fns.FindWindowExW(top, 0, 'SHELLDLL_DefView', null);
      if (nonZero(shell)) {
        const w = fns.FindWindowExW(0, top, 'WorkerW', null);
        if (nonZero(w)) worker = w;
      }
    } catch (_) { /* ignore per-window errors */ }
    return true;
  }, koffi.pointer(EnumProc));
  try {
    fns.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  // Fallback: some builds host icons directly under Progman.
  return nonZero(worker) ? worker : progman;
}

function getWorker() {
  if (!nonZero(cachedWorker)) cachedWorker = findWorkerW();
  return cachedWorker;
}

// Pin one window for the given mode. `desired` (optional) is the canonical
// logical bounds to restore to — pass the stored section bounds so we heal any
// previous size drift instead of trusting the (possibly shrunk) live size.
//
// IMPORTANT: we restore size via Electron's win.setBounds() (which converts
// logical DIP -> physical pixels for the target monitor) and NEVER via a raw
// SetWindowPos with DIP values — that mismatch is what caused the shrink loop.
function pin(win, embed, desired) {
  if (!loaded || win.isDestroyed()) return false;
  const hwnd = hwndOf(win);
  const target = desired || win.getBounds();
  try {
    if (embed) {
      if (!win.__embedded) fns.SetParent(hwnd, getWorker());
      win.setBounds(target);           // stable & idempotent (always canonical size)
      win.__embedded = true;
      return true;
    }
    // Floating: detach from the desktop layer. We do NOT force the window to the
    // bottom of the z-order — that made it hide behind open apps ("not running").
    // Normal window stacking already keeps it behind whatever app you focus.
    if (win.__embedded) {
      fns.SetParent(hwnd, 0);
      win.setBounds(target);
      win.__embedded = false;
    }
    return true;
  } catch (e) {
    console.warn('[desktopPin] pin failed:', e.message);
    return false;
  }
}

function sendToBottom(win) {
  if (!loaded || win.isDestroyed()) return;
  try {
    fns.SetWindowPos(
      hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    );
  } catch (_) { /* ignore */ }
}

function refreshWorker() { cachedWorker = null; }
function isAvailable() { return loaded; }

// ---------- Windows desktop-icon visibility (Fences-style clean desktop) ----------
const WM_COMMAND = 0x0111;
const CMD_TOGGLE_DESKTOP_ICONS = 0x7402; // shell command that flips icon visibility

// Locate the SHELLDLL_DefView host (icons live under it). It hangs off either
// Progman or a WorkerW depending on the Windows build.
function findDefView() {
  const progman = fns.FindWindowW('Progman', null);
  let def = fns.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null);
  let host = progman;
  if (!nonZero(def)) {
    let foundDef = 0; let foundHost = 0;
    const cb = koffi.register((top) => {
      try {
        const d = fns.FindWindowExW(top, 0, 'SHELLDLL_DefView', null);
        if (nonZero(d)) { foundDef = d; foundHost = top; }
      } catch (_) { /* ignore */ }
      return true;
    }, koffi.pointer(EnumProc));
    try { fns.EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
    def = foundDef;
    host = nonZero(foundHost) ? foundHost : progman;
  }
  return { def, host };
}

function areIconsVisible() {
  if (!loaded) return true;
  try {
    const { def } = findDefView();
    if (!nonZero(def)) return true;
    const sys = fns.FindWindowExW(def, 0, 'SysListView32', 'FolderView');
    return !!fns.IsWindowVisible(nonZero(sys) ? sys : def);
  } catch (_) { return true; }
}

function toggleIcons() {
  const { def, host } = findDefView();
  const target = nonZero(def) ? def : host;
  if (!nonZero(target)) return false;
  fns.SendMessageW(target, WM_COMMAND, CMD_TOGGLE_DESKTOP_ICONS, 0);
  return true;
}

// Deterministically show/hide the real Windows desktop icons.
function setIconsVisible(show) {
  if (!loaded) return false;
  try {
    if (areIconsVisible() !== !!show) return toggleIcons();
    return true;
  } catch (e) {
    console.warn('[desktopPin] setIconsVisible failed:', e.message);
    return false;
  }
}

module.exports = {
  init, pin, sendToBottom, refreshWorker, isAvailable,
  areIconsVisible, setIconsVisible,
};
