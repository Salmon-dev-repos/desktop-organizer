// Live "folder portal" support: read a directory and watch it for changes,
// pushing fresh listings to the owning section window.
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const store = require('./store');
const windowManager = require('./windowManager');

const watchers = new Map(); // sectionId -> chokidar watcher

function sortList(list, opts) {
  const dir = (a, b) => (opts.foldersFirst ? Number(b.isDir) - Number(a.isDir) : 0);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  list.sort((a, b) => {
    const d = dir(a, b);
    if (d) return d;
    if (opts.sort === 'date') return (b.mtime || 0) - (a.mtime || 0);
    if (opts.sort === 'type') {
      const ea = path.extname(a.name).toLowerCase();
      const eb = path.extname(b.name).toLowerCase();
      if (ea !== eb) return ea.localeCompare(eb);
      return byName(a, b);
    }
    return byName(a, b);
  });
  return list;
}

async function readFolder(folderPath, opts) {
  const options = { sort: 'name', foldersFirst: true, showHidden: false, ...(opts || {}) };
  let entries;
  try {
    entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'Folder not found' : e.message, items: [] };
  }
  const items = [];
  for (const e of entries) {
    // Best-effort hidden filter (dotfiles) — no native attrib reads needed.
    if (!options.showHidden && e.name.startsWith('.')) continue;
    const full = path.join(folderPath, e.name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* dangling link etc. */ }
    items.push({ name: e.name, path: full, isDir: e.isDirectory(), mtime });
  }
  return { error: null, items: sortList(items, options) };
}

async function pushList(sectionId) {
  const section = store.getSection(sectionId);
  if (!section || section.type !== 'portal' || !section.portal || !section.portal.folderPath) {
    windowManager.send(sectionId, 'portal:update', { id: sectionId, error: 'No folder set', items: [] });
    return;
  }
  const res = await readFolder(section.portal.folderPath, section.portal);
  windowManager.send(sectionId, 'portal:update', { id: sectionId, error: res.error, items: res.items });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function watch(sectionId) {
  unwatch(sectionId);
  const section = store.getSection(sectionId);
  if (!section || section.type !== 'portal' || !section.portal || !section.portal.folderPath) return;
  const folder = section.portal.folderPath;
  if (!fs.existsSync(folder)) return;
  const w = chokidar.watch(folder, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  const trigger = debounce(() => pushList(sectionId), 200);
  w.on('add', trigger).on('unlink', trigger).on('addDir', trigger)
    .on('unlinkDir', trigger).on('change', trigger).on('error', () => {});
  watchers.set(sectionId, w);
}

function unwatch(sectionId) {
  const w = watchers.get(sectionId);
  if (w) { w.close().catch(() => {}); watchers.delete(sectionId); }
}

function startAll() {
  for (const s of store.listSections()) {
    if (s.type === 'portal') watch(s.id);
  }
}

function stopAll() {
  for (const id of [...watchers.keys()]) unwatch(id);
}

module.exports = { readFolder, pushList, watch, unwatch, startAll, stopAll };
