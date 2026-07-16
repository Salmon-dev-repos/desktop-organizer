'use strict';
// Renderer for a single section card. `api` is the contextBridge global (window.api).
const id = new URLSearchParams(location.search).get('id');

const el = {
  body: document.body,
  card: document.getElementById('card'),
  header: document.getElementById('header'),
  chev: document.getElementById('chev'),
  title: document.getElementById('title'),
  titleInput: document.getElementById('title-input'),
  kind: document.getElementById('kind'),
  badge: document.getElementById('badge'),
  menuBtn: document.getElementById('menu-btn'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  drophint: document.getElementById('drophint'),
};

let state = null;               // section record
let settings = null;            // global settings
let portalData = { items: [], error: null };
let selected = new Set();        // selected tile keys (multi-select)
let lastKey = null;              // anchor for shift-range selection
let recycleTimer = null;
const iconCache = new Map();    // path -> Promise<dataURL|null>

// ---------- boot ----------
(async function init() {
  settings = await api.getSettings();
  applySettings(settings);
  state = await api.getSection(id);
  if (!state) return;
  render();
  if (state.type === 'portal') refreshPortal();
  if (state.type === 'recycle') startRecycle();

  wireEvents();
})();

// ---------- settings / theme ----------
function applySettings(s) {
  settings = s;
  const root = document.documentElement.style;
  root.setProperty('--accent', s.accent);
  root.setProperty('--card-opacity', String(s.opacity));
  root.setProperty('--radius', s.cornerRadius + 'px');
  root.setProperty('--icon-size', (s.iconSize || 44) + 'px');

  el.body.classList.toggle('no-labels', !s.showItemLabels);
  el.body.classList.toggle('locked', !!s.locked);

  const theme = s.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : s.theme;
  el.body.classList.toggle('theme-light', theme === 'light');
  el.body.classList.toggle('theme-dark', theme !== 'light');
}

// ---------- render ----------
// Header type chip: a labelled designation so a folder Portal (a live view of a
// real folder) is never mistaken for a Bucket (a collection of shortcuts). Only
// these two types are ambiguous — the Recycle Bin is self-evident from its icon.
const KIND_META = {
  portal: {
    label: 'Portal',
    title: 'Folder portal — a live view of a real folder on disk. Items shown are the real files; deleting one sends it to the Recycle Bin.',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.7 1.1H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M11 10.5l3 2.5-3 2.5"/></svg>',
  },
  bucket: {
    label: 'Bucket',
    title: 'Bucket — a collection of shortcuts you drag in. Removing an item deletes the shortcut only, never the real file.',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h4l1.5 2.5h5L20 13h0"/><path d="M5.5 13 6 6.2A2 2 0 0 1 8 4.4h8a2 2 0 0 1 2 1.8l.5 6.8"/></svg>',
  },
};
function renderKind() {
  const meta = KIND_META[state.type];
  if (!meta) { el.kind.hidden = true; el.kind.innerHTML = ''; return; }
  el.kind.hidden = false;
  el.kind.className = 'kind is-' + state.type;
  el.kind.title = meta.title;
  el.kind.innerHTML = meta.icon + '<span class="kind-label">' + meta.label + '</span>';
}

function render() {
  el.title.textContent = state.title || 'Section';
  renderKind();
  el.body.classList.toggle('collapsed', !!state.collapsed);
  el.body.classList.toggle('is-recycle', state.type === 'recycle');
  if (el.drophint) {
    const span = el.drophint.querySelector('span');
    if (span) span.textContent = state.type === 'recycle' ? 'Drop here to delete' : 'Drop files & folders to add';
  }
  renderGrid();
}

function currentList() {
  if (state.type === 'recycle') {
    return [{ key: 'recycle', label: 'Recycle Bin', targetPath: null, kind: 'recycle', portal: false }];
  }
  if (state.type === 'portal') {
    return portalData.items.map((f) => ({
      key: f.path, label: f.name, targetPath: f.path,
      kind: f.isDir ? 'folder' : 'file', portal: true,
    }));
  }
  return (state.items || []).map((i) => ({
    key: i.id, label: i.label, targetPath: i.targetPath, kind: i.kind, itemId: i.id, portal: false,
  }));
}

function renderGrid() {
  const list = currentList();

  if (state.type === 'recycle') {
    el.body.classList.remove('is-empty');
  } else {
    el.badge.hidden = list.length === 0;
    el.badge.textContent = String(list.length);
    const empty = list.length === 0;
    el.body.classList.toggle('is-empty', empty);
    if (empty) {
      el.empty.innerHTML = '';
      const big = document.createElement('div'); big.className = 'big'; big.textContent = state.type === 'portal' ? '🗂️' : '➕';
      const msg = document.createElement('div');
      if (state.type === 'portal') {
        msg.textContent = state.portal && state.portal.folderPath ? 'This folder is empty' : 'Right-click ⋯ → Set folder…';
        if (portalData.error) { msg.className = 'err'; msg.textContent = portalData.error; }
      } else {
        msg.textContent = 'Drag files & folders here';
      }
      el.empty.append(big, msg);
    }
  }

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const it of list) frag.appendChild(makeTile(it));
  el.grid.appendChild(frag);

  // Drop selection keys that no longer exist, then repaint selection state.
  const keys = new Set(list.map((i) => i.key));
  for (const k of [...selected]) if (!keys.has(k)) selected.delete(k);
  applySelectionClasses();
}

function makeTile(it) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (selected.has(it.key) ? ' selected' : '') + (it.kind === 'recycle' ? ' recycle' : '');
  tile.dataset.key = it.key;
  tile.dataset.path = it.targetPath || '';
  tile.dataset.kind = it.kind;
  tile.dataset.portal = it.portal ? '1' : '';
  if (it.itemId) tile.dataset.itemId = it.itemId;
  // Real files/folders can be dragged out to Explorer, another card, or the bin.
  if (it.kind !== 'recycle' && it.kind !== 'url') tile.draggable = true;
  tile.title = it.targetPath || it.label;

  const ic = document.createElement('div'); ic.className = 'ic';
  const label = document.createElement('div'); label.className = 'label'; label.textContent = it.label;
  tile.append(ic, label);

  paintIcon(ic, it);
  return tile;
}

function paintIcon(ic, it) {
  if (it.kind === 'recycle') {
    api.recycleIcon().then((url) => {
      ic.innerHTML = '';
      if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; ic.appendChild(img); }
      else ic.appendChild(glyph('🗑️'));
    });
    return;
  }
  if (it.kind === 'url') { ic.appendChild(glyph('🔗')); return; }
  loadIcon(it.targetPath).then((url) => {
    if (url) {
      const img = document.createElement('img');
      img.src = url; img.alt = '';
      ic.innerHTML = ''; ic.appendChild(img);
    } else {
      ic.innerHTML = ''; ic.appendChild(glyph(it.kind === 'folder' ? '📁' : '📄'));
    }
  });
}
function glyph(ch) { const g = document.createElement('div'); g.className = 'glyph'; g.textContent = ch; return g; }
function loadIcon(p) {
  if (!iconCache.has(p)) iconCache.set(p, api.getIcon(p).catch(() => null));
  return iconCache.get(p);
}

async function refreshPortal() {
  portalData = await api.listPortal(id);
  renderGrid();
}

// ---------- recycle bin ----------
function startRecycle() {
  refreshRecycle();
  clearInterval(recycleTimer);
  recycleTimer = setInterval(refreshRecycle, 5000);
  window.addEventListener('focus', refreshRecycle);
}
async function refreshRecycle() {
  if (!state || state.type !== 'recycle') return;
  const info = await api.recycleInfo();
  const n = info ? info.items : 0;
  el.badge.hidden = !(n > 0);
  el.badge.textContent = String(n);
  // Re-pull the icon so it flips between empty/full.
  const tile = el.grid.querySelector('.tile.recycle .ic');
  const url = await api.recycleIcon();
  if (tile) {
    tile.innerHTML = '';
    if (url) { const img = document.createElement('img'); img.src = url; tile.appendChild(img); }
    else tile.appendChild(glyph('🗑️'));
  }
}

// ---------- selection ----------
function tileByKey(key) { return el.grid.querySelector(`.tile[data-key="${CSS.escape(key)}"]`); }
function pathsOf(keys) {
  return keys.map((k) => tileByKey(k)).filter(Boolean).map((t) => t.dataset.path).filter(Boolean);
}
function applySelectionClasses() {
  for (const t of el.grid.children) t.classList.toggle('selected', selected.has(t.dataset.key));
}
function clearSelection() { selected.clear(); lastKey = null; applySelectionClasses(); }
function selectOnly(key) { selected = new Set([key]); lastKey = key; applySelectionClasses(); }
function toggleKey(key) { if (selected.has(key)) selected.delete(key); else selected.add(key); lastKey = key; applySelectionClasses(); }
function selectRange(toKey) {
  const keys = currentList().map((i) => i.key);
  const a = keys.indexOf(lastKey != null ? lastKey : toKey), b = keys.indexOf(toKey);
  if (a < 0 || b < 0) { selectOnly(toKey); return; }
  const lo = Math.min(a, b), hi = Math.max(a, b);
  selected = new Set(keys.slice(lo, hi + 1)); applySelectionClasses();
}
function selectAll() { selected = new Set(currentList().map((i) => i.key)); applySelectionClasses(); }
function isEditing() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

// ---------- events ----------
function wireEvents() {
  el.chev.addEventListener('click', toggleCollapse);
  el.menuBtn.addEventListener('click', () => api.headerMenu(id));
  el.header.addEventListener('contextmenu', (e) => { e.preventDefault(); api.headerMenu(id); });
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => api.openSettings());

  el.title.addEventListener('dblclick', startTitleRename);

  // Grid interactions (event delegation).
  el.grid.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('.tile'); if (!tile) return;
    if (tile.dataset.kind === 'recycle') { api.recycleOpen(); return; }
    api.openItem(tile.dataset.path);
  });
  el.grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile'); if (!tile) { clearSelection(); return; }
    if (tile.dataset.kind === 'recycle') return;
    const key = tile.dataset.key;
    if (e.ctrlKey || e.metaKey) toggleKey(key);
    else if (e.shiftKey) selectRange(key);
    else selectOnly(key);
  });
  el.grid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.tile'); if (!tile) return;
    e.preventDefault();
    if (tile.dataset.kind === 'recycle') { api.recycleMenu(e.screenX, e.screenY); return; }
    const key = tile.dataset.key;
    if (!selected.has(key)) selectOnly(key);
    const keys = [...selected];
    api.itemMenu(id, {
      paths: pathsOf(keys),
      keys,
      primaryKey: key,
      portal: state.type === 'portal',
      x: e.screenX, y: e.screenY,
    });
  });
  // Right-click on empty space in a folder portal -> the folder's own shell menu
  // (Paste, New, View, Properties…), so a portal behaves like an Explorer window.
  el.body.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return;               // handled above
    if (state.type !== 'portal' || !state.portal || !state.portal.folderPath) return;
    e.preventDefault();
    clearSelection();
    api.itemMenu(id, {
      paths: [state.portal.folderPath], keys: [], primaryKey: null,
      portal: true, x: e.screenX, y: e.screenY,
    });
  });

  // Drag a file/folder OUT (to Explorer, another card, or the Recycle Bin).
  el.grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || tile.dataset.kind === 'recycle' || tile.dataset.kind === 'url' || !tile.dataset.path) {
      e.preventDefault(); return;
    }
    const key = tile.dataset.key;
    if (!selected.has(key)) selectOnly(key);
    const paths = pathsOf([...selected]);
    e.preventDefault(); // suppress HTML drag; use the native shell drag from main
    if (paths.length) api.startDrag(paths);
  });

  setupDragDrop();
  setupResize();
  setupKeyboard();

  // Main -> renderer.
  api.onState((s) => {
    if (s && s.id === id) {
      state = s; render();
      if (state.type === 'portal') refreshPortal();
      if (state.type === 'recycle') refreshRecycle();
    }
  });
  api.onSettings((s) => applySettings(s));
  api.onLock((locked) => el.body.classList.toggle('locked', !!locked));
  api.onPortal((data) => { if (data && data.id === id) { portalData = data; renderGrid(); } });
  api.onUiAction((a) => {
    if (a.type === 'renameSection') startTitleRename();
    else if (a.type === 'renameItem') startItemRename(a.key);
  });

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (settings && settings.theme === 'auto') applySettings(settings);
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', async (e) => {
    if (isEditing()) return;
    if (state.type === 'recycle') return;
    const keys = [...selected];
    const k = e.key;
    if (k === 'Delete' && keys.length) {
      e.preventDefault();
      if (state.type === 'portal') {
        await api.deleteItems(pathsOf(keys));           // real files -> Recycle Bin
      } else {
        for (const key of keys) await api.removeItem(id, key); // bucket -> remove shortcut only
      }
      clearSelection();
    } else if (k === 'F2' && keys.length === 1) {
      e.preventDefault(); startItemRename(keys[0]);
    } else if (k === 'Enter' && keys.length) {
      e.preventDefault(); pathsOf(keys).forEach((p) => api.openItem(p));
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') {
      e.preventDefault(); selectAll();
    } else if (k === 'Escape') {
      clearSelection();
    }
  });
}

function toggleCollapse() {
  const next = !state.collapsed;
  state.collapsed = next;
  el.body.classList.toggle('collapsed', next);
  api.setCollapsed(id, next);
}

// ---------- rename ----------
function startTitleRename() {
  el.title.hidden = true;
  el.titleInput.hidden = false;
  el.titleInput.value = state.title || '';
  el.titleInput.focus();
  el.titleInput.select();
  const commit = (save) => {
    el.titleInput.hidden = true;
    el.title.hidden = false;
    el.titleInput.removeEventListener('keydown', onKey);
    el.titleInput.removeEventListener('blur', onBlur);
    if (save) {
      const v = el.titleInput.value.trim() || 'Section';
      state.title = v; el.title.textContent = v; api.setTitle(id, v);
    }
  };
  const onKey = (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  const onBlur = () => commit(true);
  el.titleInput.addEventListener('keydown', onKey);
  el.titleInput.addEventListener('blur', onBlur);
}

// Rename a tile. For portal items this renames the REAL file on disk; for bucket
// items it renames just the shortcut's label.
function startItemRename(key) {
  const tile = tileByKey(key);
  if (!tile || tile.dataset.kind === 'recycle') return;
  const label = tile.querySelector('.label');
  if (!label) return;
  const original = label.textContent;
  const isPortal = tile.dataset.portal === '1';
  const oldPath = tile.dataset.path;
  const input = document.createElement('input');
  input.className = 'label-input';
  input.value = original;
  label.replaceWith(input);
  input.focus(); input.select();
  const finish = (save) => {
    const v = input.value.trim();
    const restore = document.createElement('div'); restore.className = 'label';
    restore.textContent = save && v ? v : original;
    input.replaceWith(restore);
    if (save && v && v !== original) {
      if (isPortal) {
        api.renameFile(oldPath, v).then((r) => {
          if (!r || !r.ok) restore.textContent = original; // watcher will re-render on success
        });
      } else {
        api.renameItem(id, tile.dataset.itemId, v);
      }
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- drag & drop ----------
function setupDragDrop() {
  const type = () => state && state.type;
  const portalHasFolder = () => type() === 'portal' && state.portal && state.portal.folderPath;
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (type() === 'bucket') { e.dataTransfer.dropEffect = 'copy'; el.body.classList.add('dragging'); }
    else if (type() === 'recycle') { e.dataTransfer.dropEffect = 'move'; el.body.classList.add('dragging'); }
    else if (portalHasFolder()) {
      // Copy into the real folder by default (item stays in its source too);
      // hold Shift to move it instead — same convention as Explorer.
      e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
      el.body.classList.add('dragging');
    }
    else { e.dataTransfer.dropEffect = 'none'; }
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) el.body.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.body.classList.remove('dragging');
    const paths = [];
    for (const f of e.dataTransfer.files) {
      const p = api.pathForFile(f);
      if (p) paths.push(p);
    }
    if (type() === 'recycle') {
      if (paths.length) { await api.deleteItems(paths); refreshRecycle(); }
      return;
    }
    if (type() === 'bucket') {
      const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (!paths.length && uri && /^[a-z]+:\/\//i.test(uri.trim())) paths.push(uri.trim());
      if (paths.length) {
        const items = await api.addItems(id, paths);
        state.items = items; renderGrid();
      }
      return;
    }
    if (portalHasFolder() && paths.length) {
      // Put the real files into the portal's folder so they show up here. The
      // folder watcher re-renders on the change; refresh too for immediacy.
      await api.dropIntoFolder(state.portal.folderPath, paths, e.shiftKey ? 'move' : 'copy');
      refreshPortal();
    }
  });
}

// ---------- resize via edge/corner grips ----------
function setupResize() {
  for (const h of document.querySelectorAll('.rh')) {
    // The direction token is the non-"rh" class: n|s|e|w|ne|nw|se|sw.
    const dir = [...h.classList].find((c) => c !== 'rh') || '';
    h.addEventListener('pointerdown', (e) => onResizeStart(e, dir));
  }
}

async function onResizeStart(e, dir) {
  if (settings && settings.locked) return;
  e.preventDefault();
  const handle = e.currentTarget || e.target;
  // Pointer capture keeps events flowing to us during the drag, but it's just an
  // optimization — never let it throw (e.g. synthetic/edge pointers).
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }

  const start = (await api.getBounds(id)) || state.bounds || { x: 0, y: 0, width: 300, height: 240 };
  const sx = e.screenX, sy = e.screenY;
  const grid = settings && settings.snapToGrid ? Math.max(2, settings.gridSize || 16) : 1;
  const MIN_W = 180, MIN_H = 120;

  // Substring match so corners ("se", "nw", …) affect BOTH axes.
  const has = (d) => dir.includes(d);
  const compute = (ev) => {
    const dx = ev.screenX - sx, dy = ev.screenY - sy;
    let { x, y, width, height } = start;
    if (has('e')) width = start.width + dx;
    if (has('s')) height = start.height + dy;
    if (has('w')) width = start.width - dx;
    if (has('n')) height = start.height - dy;
    width = Math.max(MIN_W, snap(width, grid));
    height = Math.max(MIN_H, snap(height, grid));
    if (has('w')) x = start.x + (start.width - width);
    if (has('n')) y = start.y + (start.height - height);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  };

  // Apply directly on each move (no requestAnimationFrame — these background
  // windows can have rAF throttled/paused; the main process debounces the write).
  const onMove = (ev) => { const b = compute(ev); state.bounds = b; api.setBounds(id, b); };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function snap(v, grid) { return grid > 1 ? Math.round(v / grid) * grid : v; }
