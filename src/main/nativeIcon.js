// Real Windows shell icons for folders.
//
// Electron's app.getFileIcon() is reliable for files but returns a broken generic
// "computer" glyph for *directories* (it treats folders as generic files). So for
// folders we pull the true shell icon ourselves via SHGetFileInfo + GDI, the same
// koffi/native approach used by desktopPin.js. This also yields the distinct icons
// Windows gives special folders (Downloads, Pictures, Music, …).
//
// Everything here is best-effort and win32-only: if koffi or any Win32 call fails,
// folderIcon() returns null and the renderer falls back to a 📁 glyph.
let koffi = null;
let loaded = false;
let init_tried = false;
let fns = null;

const SHGFI_ICON = 0x000000100;
const SHGFI_LARGEICON = 0x000000000; // 32x32 (scaled by DPI)
const SHGFI_USEFILEATTRIBUTES = 0x000000010;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

function init() {
  if (init_tried) return loaded;
  init_tried = true;
  if (process.platform !== 'win32') return false;
  try {
    koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const user32 = koffi.load('user32.dll');

    koffi.struct('SHFILEINFOW', {
      hIcon: 'uintptr',
      iIcon: 'int',
      dwAttributes: 'uint32',
      szDisplayName: koffi.array('char16', 260),
      szTypeName: koffi.array('char16', 80),
    });
    koffi.struct('SHSTOCKICONINFO', {
      cbSize: 'uint32',
      hIcon: 'uintptr',
      iSysImageIndex: 'int',
      iIcon: 'int',
      szPath: koffi.array('char16', 260),
    });
    koffi.struct('ICONINFO', {
      fIcon: 'int', xHotspot: 'uint32', yHotspot: 'uint32',
      hbmMask: 'uintptr', hbmColor: 'uintptr',
    });
    koffi.struct('BITMAP', {
      bmType: 'long', bmWidth: 'long', bmHeight: 'long', bmWidthBytes: 'long',
      bmPlanes: 'uint16', bmBitsPixel: 'uint16', bmBits: 'void*',
    });
    koffi.struct('BITMAPINFOHEADER', {
      biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16',
      biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32',
      biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32',
    });

    fns = {
      SHGetFileInfoW: shell32.func('uintptr SHGetFileInfoW(str16, uint32, _Inout_ SHFILEINFOW*, uint32, uint32)'),
      SHGetStockIconInfo: shell32.func('int SHGetStockIconInfo(int, uint32, _Inout_ SHSTOCKICONINFO*)'),
      GetIconInfo: user32.func('int GetIconInfo(uintptr, _Out_ ICONINFO*)'),
      GetObjectW: gdi32.func('int GetObjectW(uintptr, int, _Out_ BITMAP*)'),
      GetDC: user32.func('uintptr GetDC(uintptr)'),
      ReleaseDC: user32.func('int ReleaseDC(uintptr, uintptr)'),
      GetDIBits: gdi32.func('int GetDIBits(uintptr, uintptr, uint32, uint32, void*, _Inout_ BITMAPINFOHEADER*, uint32)'),
      DestroyIcon: user32.func('int DestroyIcon(uintptr)'),
      DeleteObject: gdi32.func('int DeleteObject(uintptr)'),
    };
    loaded = true;
  } catch (e) {
    console.warn('[nativeIcon] native folder icons unavailable:', e.message);
    loaded = false;
  }
  return loaded;
}

// HICON -> BGRA pixels -> Electron NativeImage. Does NOT destroy the icon.
function hiconToImage(nativeImage, hicon) {
  if (!hicon) return null;
  const ii = {};
  if (!fns.GetIconInfo(hicon, ii)) return null;
  try {
    const bm = {};
    fns.GetObjectW(ii.hbmColor, koffi.sizeof('BITMAP'), bm);
    const w = bm.bmWidth, h = bm.bmHeight;
    if (!w || !h) return null;
    const buf = Buffer.alloc(w * h * 4);
    // Negative height => top-down rows, matching NativeImage's expectation.
    const bih = {
      biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
      biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
      biClrUsed: 0, biClrImportant: 0,
    };
    const hdc = fns.GetDC(0);
    const lines = fns.GetDIBits(hdc, ii.hbmColor, 0, h, buf, bih, 0);
    fns.ReleaseDC(0, hdc);
    if (!lines) return null;
    // Legacy icons with no alpha channel read back fully transparent; force opaque.
    let anyAlpha = false;
    for (let i = 3; i < buf.length; i += 4) { if (buf[i] !== 0) { anyAlpha = true; break; } }
    if (!anyAlpha) for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    const img = nativeImage.createFromBitmap(buf, { width: w, height: h });
    return img && !img.isEmpty() ? img : null;
  } finally {
    if (ii.hbmColor) fns.DeleteObject(ii.hbmColor);
    if (ii.hbmMask) fns.DeleteObject(ii.hbmMask);
  }
}

// SHGetFileInfo -> HICON -> NativeImage. Returns image or null.
function iconToImage(nativeImage, targetPath, useAttrs) {
  const sfi = {};
  const flags = SHGFI_ICON | SHGFI_LARGEICON | (useAttrs ? SHGFI_USEFILEATTRIBUTES : 0);
  const attr = useAttrs ? FILE_ATTRIBUTE_DIRECTORY : 0;
  const r = fns.SHGetFileInfoW(targetPath, attr, sfi, koffi.sizeof('SHFILEINFOW'), flags);
  if (!r || !sfi.hIcon) return null;
  try {
    return hiconToImage(nativeImage, sfi.hIcon);
  } finally {
    fns.DestroyIcon(sfi.hIcon);
  }
}

// A Windows "stock" shell icon (SIID_*) as a data URL, or null. Used for the
// Recycle Bin (empty = 55 / full = 56) so a hidden-icons desktop still has one.
const SHGSI_ICON = 0x000000100;
const SHGSI_LARGEICON = 0x000000000;
function stockIcon(nativeImage, siid) {
  if (!init()) return null;
  try {
    const info = { cbSize: koffi.sizeof('SHSTOCKICONINFO'), hIcon: 0, iSysImageIndex: 0, iIcon: 0 };
    if (fns.SHGetStockIconInfo(siid, SHGSI_ICON | SHGSI_LARGEICON, info) !== 0 || !info.hIcon) return null;
    try {
      const img = hiconToImage(nativeImage, info.hIcon);
      return img ? img.toDataURL() : null;
    } finally {
      fns.DestroyIcon(info.hIcon);
    }
  } catch (_) { return null; }
}

// Returns a data URL for a folder's real shell icon, or null if unavailable.
// `nativeImage` is passed in to avoid this module importing electron directly.
function folderIcon(nativeImage, folderPath) {
  if (!init()) return null;
  try {
    // Real path first: honors special/custom folder icons (Downloads, Pictures, …).
    let img = folderPath ? iconToImage(nativeImage, folderPath, false) : null;
    // Fall back to the generic folder icon without touching the disk.
    if (!img) img = iconToImage(nativeImage, 'folder', true);
    return img ? img.toDataURL() : null;
  } catch (e) {
    return null;
  }
}

function isAvailable() { return init(); }

module.exports = { folderIcon, stockIcon, isAvailable };
