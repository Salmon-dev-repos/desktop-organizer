// Extracts native file/folder icons via Electron (no native deps) and caches them.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const nativeIcon = require('./nativeIcon');

const cache = new Map(); // path -> dataURL (or null)

function isDir(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

async function getIcon(target) {
  if (!target) return null;
  if (cache.has(target)) return cache.get(target);
  // URLs have no filesystem icon — let the renderer show a glyph.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    cache.set(target, null);
    return null;
  }
  try {
    // Electron's getFileIcon returns a broken generic glyph for directories, so
    // pull the real shell folder icon natively; files use getFileIcon as normal.
    // If native extraction fails we return null (renderer shows a 📁 glyph) rather
    // than fall back to getFileIcon's broken directory icon.
    let url;
    if (isDir(target)) {
      url = nativeIcon.folderIcon(nativeImage, target);
    } else {
      const img = await app.getFileIcon(target, { size: 'large' });
      url = img && !img.isEmpty() ? img.toDataURL() : null;
    }
    cache.set(target, url);
    return url;
  } catch {
    cache.set(target, null);
    return null;
  }
}

// Folder contents can change icons rarely; allow targeted invalidation.
function invalidate(target) { cache.delete(target); }
function clear() { cache.clear(); }

module.exports = { getIcon, invalidate, clear };
