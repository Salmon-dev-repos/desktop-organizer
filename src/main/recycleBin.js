// Recycle Bin support so a "hidden desktop icons" setup still has a working bin.
// Open it, empty it (with the normal Windows confirmation), query its state to
// pick the empty/full icon, and send dropped files to it.
const { shell, nativeImage } = require('electron');
const { execFile } = require('child_process');
const nativeIcon = require('./nativeIcon');

// Parsing name for the Recycle Bin virtual folder (used by shellMenu too).
const RECYCLE_PARSE = '::{645FF040-5081-101B-9F08-00AA002F954E}';
const SIID_RECYCLER = 55;      // empty
const SIID_RECYCLERFULL = 56;  // has items

let koffi = null;
let shell32 = null;
let loaded = false;
let initTried = false;
let fns = null;

function init() {
  if (initTried) return loaded;
  initTried = true;
  if (process.platform !== 'win32') return false;
  try {
    koffi = require('koffi');
    shell32 = koffi.load('shell32.dll');
    koffi.struct('SHQUERYRBINFO', { cbSize: 'uint32', i64Size: 'int64', i64NumItems: 'int64' });
    fns = {
      SHEmptyRecycleBinW: shell32.func('int __stdcall SHEmptyRecycleBinW(uintptr, str16, uint32)'),
      SHQueryRecycleBinW: shell32.func('int __stdcall SHQueryRecycleBinW(str16, _Inout_ SHQUERYRBINFO*)'),
    };
    loaded = true;
  } catch (e) {
    console.warn('[recycleBin] native unavailable:', e.message);
    loaded = false;
  }
  return loaded;
}

function hwndOf(win) {
  try {
    if (!win || win.isDestroyed()) return 0n;
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch (_) { return 0n; }
}

// { items, size } across all drives, or null if it can't be determined.
function query() {
  if (!init()) return null;
  try {
    const info = { cbSize: koffi.sizeof('SHQUERYRBINFO'), i64Size: 0n, i64NumItems: 0n };
    if (fns.SHQueryRecycleBinW(null, info) !== 0) return null;
    return { items: Number(info.i64NumItems), size: Number(info.i64Size) };
  } catch (_) { return null; }
}

// Whether the bin currently holds anything (defaults to false if unknown).
function hasItems() {
  const q = query();
  return q ? q.items > 0 : false;
}

// Data URL for the correct (empty/full) Recycle Bin icon.
function icon() {
  return nativeIcon.stockIcon(nativeImage, hasItems() ? SIID_RECYCLERFULL : SIID_RECYCLER);
}

// Open the Recycle Bin in Explorer.
function open() {
  try {
    const p = execFile('explorer.exe', ['shell:RecycleBinFolder']);
    p.on('error', () => {});
  } catch (_) { /* ignore */ }
}

// Empty the bin with Windows' normal confirmation + progress UI.
function empty(win) {
  if (!init()) return false;
  try {
    fns.SHEmptyRecycleBinW(hwndOf(win), null, 0);
    return true;
  } catch (_) { return false; }
}

// Send files/folders to the Recycle Bin (used by drag-onto-bin and Delete key).
// Returns the number successfully trashed.
async function deleteToRecycle(paths) {
  let n = 0;
  for (const p of paths || []) {
    try { await shell.trashItem(p); n++; } catch (_) { /* skip */ }
  }
  return n;
}

module.exports = { RECYCLE_PARSE, init, query, hasItems, icon, open, empty, deleteToRecycle };
