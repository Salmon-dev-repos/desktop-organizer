// The REAL Windows Explorer right-click menu, shown for the file(s) under the
// cursor inside a section card.
//
// Instead of Electron's own Menu, we drive the Windows shell's IContextMenu COM
// interface directly via koffi (the same FFI layer desktopPin/nativeIcon use):
//   SHParseDisplayName -> absolute PIDL
//   SHBindToParent     -> parent IShellFolder + child PIDL
//   GetUIObjectOf      -> IContextMenu for the item(s)
//   QueryContextMenu   -> populate an HMENU (incl. every third-party extension)
//   TrackPopupMenuEx   -> show it, return the chosen command id
//   InvokeCommand      -> let Windows run it (open, cut/copy/paste, delete,
//                         send to, properties, shell-extension verbs, …)
//
// A hidden owner window forwards WM_INITMENUPOPUP / WM_DRAWITEM / WM_MEASUREITEM
// / WM_MENUCHAR to IContextMenu2/3 so cascading submenus ("Send to", "Open
// with", "New", "Give access to") and owner-drawn icons populate correctly.
//
// Everything is best-effort and win32-only. Any failure returns {ok:false} and
// the caller falls back to the built-in Electron menu — the app never crashes.
const path = require('path');

let koffi = null;
let loaded = false;
let initTried = false;
let lib = null;      // { fn, proto, iid }
let ownerHwnd = 0n;  // reusable hidden owner window
let active = null;   // IContextMenu2/3 pointer live during a popup (for WndProc)
let wndProcPtr = null;

// ---- constants ----
const CMF_NORMAL = 0x0;
const CMF_EXTENDEDVERBS = 0x100;
const TPM_RETURNCMD = 0x0100;
const TPM_RIGHTBUTTON = 0x0002;
const TPM_LEFTALIGN = 0x0000;
const SW_SHOWNORMAL = 1;
const CMIC_MASK_UNICODE = 0x00004000;
const CMIC_MASK_PTINVOKE = 0x20000000;
const GCS_VERBW = 0x00000004;
const MF_BYPOSITION = 0x0400;
const WS_POPUP = 0x80000000;
const WM_INITMENUPOPUP = 0x0117;
const WM_DRAWITEM = 0x002b;
const WM_MEASUREITEM = 0x002c;
const WM_MENUCHAR = 0x0120;

function guid(str) {
  const m = str.replace(/[{}]/g, '').split('-');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(m[0], 16), 0);
  b.writeUInt16LE(parseInt(m[1], 16), 4);
  b.writeUInt16LE(parseInt(m[2], 16), 6);
  const d4 = m[3] + m[4];
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(d4.substr(i * 2, 2), 16);
  return b;
}

function init() {
  if (initTried) return loaded;
  initTried = true;
  if (process.platform !== 'win32') return false;
  try {
    koffi = require('koffi');
    const ole32 = koffi.load('ole32.dll');
    const shell32 = koffi.load('shell32.dll');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    koffi.struct('WNDCLASSW', {
      style: 'uint32', lpfnWndProc: 'void*', cbClsExtra: 'int', cbWndExtra: 'int',
      hInstance: 'uintptr', hIcon: 'uintptr', hCursor: 'uintptr', hbrBackground: 'uintptr',
      lpszMenuName: 'void*', lpszClassName: 'str16',
    });
    // CMINVOKECOMMANDINFOEX (x64, sizeof 104). POINT split into two int32.
    koffi.struct('CMINVOKECOMMANDINFOEX', {
      cbSize: 'uint32', fMask: 'uint32', hwnd: 'uintptr',
      lpVerb: 'uintptr', lpParameters: 'uintptr', lpDirectory: 'uintptr',
      nShow: 'int32', dwHotKey: 'uint32', hIcon: 'uintptr', lpTitle: 'uintptr',
      lpVerbW: 'uintptr', lpParametersW: 'uintptr', lpDirectoryW: 'uintptr', lpTitleW: 'uintptr',
      ptInvokeX: 'int32', ptInvokeY: 'int32',
    });

    const fn = {
      CoInitializeEx: ole32.func('int __stdcall CoInitializeEx(void*, uint32)'),
      CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void*)'),
      SHParseDisplayName: shell32.func('int __stdcall SHParseDisplayName(str16, void*, _Out_ void**, uint32, void*)'),
      SHBindToParent: shell32.func('int __stdcall SHBindToParent(void*, void*, _Out_ void**, void*)'),
      CreatePopupMenu: user32.func('uintptr __stdcall CreatePopupMenu()'),
      DestroyMenu: user32.func('int __stdcall DestroyMenu(uintptr)'),
      GetMenuItemCount: user32.func('int __stdcall GetMenuItemCount(uintptr)'),
      TrackPopupMenuEx: user32.func('int __stdcall TrackPopupMenuEx(uintptr, uint32, int, int, uintptr, void*)'),
      SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(uintptr)'),
      PostMessageW: user32.func('int __stdcall PostMessageW(uintptr, uint32, uintptr, intptr)'),
      RegisterClassW: user32.func('uint16 __stdcall RegisterClassW(WNDCLASSW*)'),
      CreateWindowExW: user32.func('uintptr __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, uintptr, uintptr, uintptr, void*)'),
      DefWindowProcW: user32.func('intptr __stdcall DefWindowProcW(uintptr, uint32, uintptr, intptr)'),
      GetModuleHandleW: kernel32.func('uintptr __stdcall GetModuleHandleW(str16)'),
    };
    const proto = {
      AddRef: koffi.proto('uint32 __stdcall AddRef(void*)'),
      Release: koffi.proto('uint32 __stdcall Release(void*)'),
      QueryInterface: koffi.proto('int __stdcall QueryInterface(void*, void*, _Out_ void**)'),
      GetUIObjectOf: koffi.proto('int __stdcall GetUIObjectOf(void*, uintptr, uint32, void*, void*, void*, _Out_ void**)'),
      QueryContextMenu: koffi.proto('int __stdcall QueryContextMenu(void*, uintptr, uint32, uint32, uint32, uint32)'),
      InvokeCommand: koffi.proto('int __stdcall InvokeCommand(void*, CMINVOKECOMMANDINFOEX*)'),
      GetCommandString: koffi.proto('int __stdcall GetCommandString(void*, uintptr, uint32, void*, void*, uint32)'),
      HandleMenuMsg: koffi.proto('int __stdcall HandleMenuMsg(void*, uint32, uintptr, intptr)'),
      HandleMenuMsg2: koffi.proto('int __stdcall HandleMenuMsg2(void*, uint32, uintptr, intptr, void*)'),
      WndProc: koffi.proto('intptr __stdcall WndProc(uintptr, uint32, uintptr, intptr)'),
    };
    const iid = {
      IShellFolder: guid('{000214E6-0000-0000-C000-000000000046}'),
      IContextMenu: guid('{000214E4-0000-0000-C000-000000000046}'),
      IContextMenu2: guid('{000214F4-0000-0000-C000-000000000046}'),
      IContextMenu3: guid('{BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}'),
    };
    lib = { fn, proto, iid };
    fn.CoInitializeEx(null, 2); // STA; S_FALSE/RPC_E_CHANGED_MODE are both fine
    loaded = true;
  } catch (e) {
    console.warn('[shellMenu] unavailable:', e.message);
    loaded = false;
  }
  return loaded;
}

// Call COM vtable method `index` on interface `ptr`.
function vcall(ptr, index, proto, ...args) {
  const vtbl = koffi.decode(ptr, 'void*');
  const fnAddr = koffi.decode(vtbl, index * 8, 'void*');
  return koffi.call(fnAddr, proto, ptr, ...args);
}
function release(ptr) { try { if (ptr) vcall(ptr, 2, lib.proto.Release); } catch (_) {} }

// Message forwarding so cascading/owner-drawn shell menus work.
function wndProc(hwnd, msg, wParam, lParam) {
  if (active && (msg === WM_INITMENUPOPUP || msg === WM_DRAWITEM || msg === WM_MEASUREITEM || msg === WM_MENUCHAR)) {
    try {
      if (active.iface === 3) {
        const res = Buffer.alloc(8);
        vcall(active.ptr, 7, lib.proto.HandleMenuMsg2, msg, wParam, lParam, res);
        if (msg === WM_MENUCHAR) return res.readBigInt64LE(0);
      } else {
        vcall(active.ptr, 6, lib.proto.HandleMenuMsg, msg, wParam, lParam);
      }
      if (msg === WM_DRAWITEM || msg === WM_MEASUREITEM) return 1n;
      return 0n;
    } catch (_) { /* fall through to default */ }
  }
  return lib.fn.DefWindowProcW(hwnd, msg, wParam, lParam);
}

function ensureOwnerWindow() {
  if (ownerHwnd) return ownerHwnd;
  const CLASS = 'DesktopOrganizerShellMenuOwner';
  const hInst = lib.fn.GetModuleHandleW(null);
  if (!wndProcPtr) wndProcPtr = koffi.register(wndProc, koffi.pointer(lib.proto.WndProc));
  const wc = {
    style: 0, lpfnWndProc: wndProcPtr, cbClsExtra: 0, cbWndExtra: 0,
    hInstance: hInst, hIcon: 0, hCursor: 0, hbrBackground: 0,
    lpszMenuName: null, lpszClassName: CLASS,
  };
  lib.fn.RegisterClassW(wc); // 0 if already registered — harmless
  ownerHwnd = lib.fn.CreateWindowExW(0, CLASS, null, WS_POPUP, 0, 0, 0, 0, 0, 0, hInst, null);
  return ownerHwnd;
}

function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch (_) { return 0n; }
}

// Parse a filesystem path (or a shell display name like "::{CLSID}") to an
// absolute PIDL. Returns the koffi external pointer, or null.
function parse(name) {
  const out = [null];
  const hr = lib.fn.SHParseDisplayName(name, null, out, 0, null);
  return hr === 0 && out[0] ? out[0] : null;
}

// Show the real shell context menu for `targets` (absolute paths and/or shell
// display names) at physical screen pixel (x, y). `win` owns any shell dialogs.
// Returns:
//   { ok:true }                 — shown; command invoked or dismissed
//   { ok:true, rename:true }    — user picked Rename; caller does in-app rename
//   { ok:false }                — native path failed; caller shows fallback menu
function popup(win, targets, x, y) {
  if (!init()) return { ok: false };
  const list = (targets || []).filter(Boolean);
  if (!list.length) return { ok: false };

  const { fn, proto, iid } = lib;
  const pidls = [];   // absolute PIDLs to free
  let psf = null;     // parent IShellFolder
  let pcm = null;     // IContextMenu
  let cm2 = null;     // IContextMenu2/3 for message forwarding
  let hMenu = 0n;
  try {
    // All targets must share one parent folder to share a single IContextMenu.
    // If they don't (e.g. a bucket mixing folders), fall back to the first item.
    const sameParent = list.every((p) => !isShellName(p))
      && list.every((p) => eqDir(p, list[0]));
    const use = sameParent ? list : [list[0]];

    const children = Buffer.alloc(8 * use.length);
    for (let i = 0; i < use.length; i++) {
      const pidl = parse(use[i]);
      if (!pidl) return { ok: false };
      pidls.push(pidl);
      const outSf = [null];
      const childBuf = Buffer.alloc(8);
      const hr = fn.SHBindToParent(pidl, iid.IShellFolder, outSf, childBuf);
      if (hr !== 0 || !outSf[0]) return { ok: false };
      if (!psf) psf = outSf[0]; else release(outSf[0]); // keep first parent only
      childBuf.copy(children, i * 8);
    }

    const hwndOwner = hwndOf(win);
    const outCm = [null];
    if (vcall(psf, 10, proto.GetUIObjectOf, hwndOwner, use.length, children, iid.IContextMenu, null, outCm) !== 0 || !outCm[0]) {
      return { ok: false };
    }
    pcm = outCm[0];

    hMenu = fn.CreatePopupMenu();
    if (!hMenu) return { ok: false };
    if (vcall(pcm, 3, proto.QueryContextMenu, hMenu, 0, 1, 0x7fff, CMF_NORMAL | CMF_EXTENDEDVERBS) < 0) {
      return { ok: false };
    }
    if (fn.GetMenuItemCount(hMenu) <= 0) return { ok: false };

    // Prefer IContextMenu3, else IContextMenu2, for the WndProc forwarder.
    const q3 = [null];
    if (vcall(pcm, 0, proto.QueryInterface, iid.IContextMenu3, q3) === 0 && q3[0]) {
      cm2 = q3[0]; active = { ptr: cm2, iface: 3 };
    } else {
      const q2 = [null];
      if (vcall(pcm, 0, proto.QueryInterface, iid.IContextMenu2, q2) === 0 && q2[0]) {
        cm2 = q2[0]; active = { ptr: cm2, iface: 2 };
      }
    }

    const owner = ensureOwnerWindow();
    // Test hook: validate the whole build pipeline without the blocking modal.
    if (process.env.DO_SHELLMENU_SELFTEST) {
      return { ok: true, selftest: true, count: fn.GetMenuItemCount(hMenu), iface: active && active.iface, owner: String(owner) };
    }
    fn.SetForegroundWindow(owner);
    const cmd = fn.TrackPopupMenuEx(
      hMenu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN, x, y, owner, null
    );
    fn.PostMessageW(owner, 0, 0, 0); // classic "dismiss cleanly" nudge
    active = null;

    if (!cmd || cmd <= 0) return { ok: true }; // dismissed

    // Rename can't work from a standalone menu (needs Explorer's view) — signal
    // the caller to run our own in-place rename instead.
    if (verbOf(pcm, cmd - 1) === 'rename') return { ok: true, rename: true };

    invoke(pcm, cmd - 1, hwndOwner, x, y);
    return { ok: true };
  } catch (e) {
    console.warn('[shellMenu] popup failed:', e.message);
    return { ok: false };
  } finally {
    active = null;
    if (hMenu) { try { fn.DestroyMenu(hMenu); } catch (_) {} }
    release(cm2);
    release(pcm);
    release(psf);
    for (const p of pidls) { try { fn.CoTaskMemFree(p); } catch (_) {} }
  }
}

function invoke(pcm, idOffset, hwndOwner, x, y) {
  const info = {
    cbSize: koffi.sizeof('CMINVOKECOMMANDINFOEX'),
    fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE,
    hwnd: hwndOwner,
    lpVerb: idOffset, lpParameters: 0, lpDirectory: 0,
    nShow: SW_SHOWNORMAL, dwHotKey: 0, hIcon: 0, lpTitle: 0,
    lpVerbW: idOffset, lpParametersW: 0, lpDirectoryW: 0, lpTitleW: 0,
    ptInvokeX: x | 0, ptInvokeY: y | 0,
  };
  vcall(pcm, 4, lib.proto.InvokeCommand, info);
}

// Canonical verb string for a command offset (e.g. "open", "delete", "rename").
function verbOf(pcm, idOffset) {
  try {
    const buf = Buffer.alloc(260 * 2);
    if (vcall(pcm, 5, lib.proto.GetCommandString, idOffset, GCS_VERBW, null, buf, 260) !== 0) return '';
    const s = buf.toString('utf16le');
    const end = s.indexOf(' ');
    return (end >= 0 ? s.slice(0, end) : s).toLowerCase();
  } catch (_) { return ''; }
}

function isShellName(p) { return typeof p === 'string' && p.startsWith('::'); }
function eqDir(a, b) {
  return path.dirname(a).toLowerCase() === path.dirname(b).toLowerCase();
}

function isAvailable() { return init(); }

module.exports = { isAvailable, popup };
