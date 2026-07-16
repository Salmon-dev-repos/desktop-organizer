// All ipcMain handlers — the single bridge between renderers and main.
const { ipcMain, BrowserWindow, dialog, shell, nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const wm = require('./windowManager');
const icons = require('./icons');
const portal = require('./folderPortal');
const menus = require('./menus');
const actions = require('./actions');
const recycleBin = require('./recycleBin');
const reminders = require('./reminders');

// A small, always-valid icon shown under the cursor while dragging files out of
// a card (Electron's startDrag requires a non-empty icon).
let dragIcon = null;
function getDragIcon() {
  if (dragIcon) return dragIcon;
  const w = 32, h = 32, buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 180; buf[i + 1] = 150; buf[i + 2] = 110; buf[i + 3] = 150; }
  dragIcon = nativeImage.createFromBitmap(buf, { width: w, height: h });
  return dragIcon;
}

// A non-clobbering destination path inside `destFolder` for `name`. If it's free,
// use it; otherwise fall back to "base - Copy.ext", then "base - Copy (2).ext", …
// (mirrors Explorer's copy-into-same-folder naming).
function uniqueDest(destFolder, name) {
  const first = path.join(destFolder, name);
  if (!fs.existsSync(first)) return first;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(destFolder, `${base} - Copy${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(destFolder, `${base} - Copy (${n})${ext}`);
  }
  return candidate;
}

function register() {
  // ----- section state -----
  ipcMain.handle('section:get', (_e, id) => wm.liveState(id) || store.getSection(id));
  ipcMain.handle('section:getBounds', (_e, id) => wm.getBounds(id));

  ipcMain.handle('section:setTitle', (_e, { id, title }) => {
    store.patchSection(id, { title });
    wm.pushState(id);
    wm.broadcast('sections:changed');
  });

  ipcMain.handle('section:setCollapsed', (_e, { id, collapsed }) => wm.setCollapsed(id, collapsed));
  ipcMain.handle('section:setBounds', (_e, { id, bounds }) => wm.setBoundsFromRenderer(id, bounds));

  // ----- bucket items -----
  ipcMain.handle('section:addItems', (_e, { id, paths }) => {
    const s = store.addItems(id, paths);
    wm.pushState(id);
    return (s && s.items) || [];
  });
  ipcMain.handle('section:removeItem', (_e, { id, itemId }) => {
    store.removeItem(id, itemId);
    wm.pushState(id);
  });
  ipcMain.handle('section:renameItem', (_e, { id, itemId, label }) => {
    store.renameItem(id, itemId, label);
    wm.pushState(id);
  });

  // ----- todos -----
  // Every mutation re-renders the list (pushState) and nudges the reminder
  // scheduler (rescan) so a near-term reminder isn't delayed a full tick.
  const afterTodo = (id) => { wm.pushState(id); reminders.rescan(); };
  ipcMain.handle('todo:add', (_e, { id, text, fields }) => {
    store.addTodo(id, { text: String(text || '').trim(), ...(fields || {}) });
    afterTodo(id);
  });
  ipcMain.handle('todo:patch', (_e, { id, todoId, patch }) => {
    store.patchTodo(id, todoId, patch || {});
    afterTodo(id);
  });
  ipcMain.handle('todo:toggle', (_e, { id, todoId }) => {
    store.toggleTodo(id, todoId);
    afterTodo(id);
  });
  ipcMain.handle('todo:remove', (_e, { id, todoId }) => {
    store.removeTodo(id, todoId);
    wm.pushState(id);
  });
  ipcMain.handle('todo:reorder', (_e, { id, orderedIds }) => {
    store.reorderTodos(id, orderedIds || []);
    wm.pushState(id);
  });
  ipcMain.handle('todo:clearDone', (_e, id) => {
    store.clearCompleted(id);
    wm.pushState(id);
  });
  ipcMain.handle('todo:setConfig', (_e, { id, patch }) => {
    store.setTodoConfig(id, patch || {});
    wm.pushState(id);
  });
  ipcMain.handle('todo:addTag', (_e, { id, name, color }) => {
    const tag = store.addTag(id, { name, color });
    wm.pushState(id);
    return tag;
  });
  ipcMain.handle('todo:removeTag', (_e, { id, tagId }) => {
    store.removeTag(id, tagId);
    wm.pushState(id);
  });

  // ----- portal -----
  ipcMain.handle('portal:list', async (_e, id) => {
    const s = store.getSection(id);
    if (!s || !s.portal || !s.portal.folderPath) return { error: 'No folder set', items: [] };
    return portal.readFolder(s.portal.folderPath, s.portal);
  });
  ipcMain.handle('section:setPortalFolder', (_e, { id, folder }) => actions.setPortalFolder(id, folder));

  // ----- open / icons -----
  ipcMain.handle('item:open', (_e, target) => menus.openTarget(target));
  ipcMain.handle('item:reveal', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('icon:get', (_e, p) => icons.getIcon(p));

  // ----- file operations (real, native) -----
  ipcMain.handle('item:delete', async (_e, paths) => recycleBin.deleteToRecycle(paths || []));
  ipcMain.handle('fs:rename', (_e, { oldPath, newName }) => {
    try {
      const clean = String(newName || '').replace(/[\\/:*?"<>|]/g, '').trim();
      if (!clean) return { ok: false, error: 'Invalid name' };
      const dest = path.join(path.dirname(oldPath), clean);
      if (dest.toLowerCase() === oldPath.toLowerCase()) return { ok: true };
      if (fs.existsSync(dest)) return { ok: false, error: 'A file with that name already exists' };
      fs.renameSync(oldPath, dest);
      icons.invalidate(oldPath);
      return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Drop real files/folders INTO a folder portal's backing folder. A portal only
  // mirrors a real folder, so the only way to make an item show there is to put
  // the real file in it. Default is a non-destructive copy (item stays in its
  // source too -> "displays in both"); mode 'move' relocates it. Never overwrites:
  // a name clash gets a unique "name - Copy" variant.
  ipcMain.handle('fs:dropInto', async (_e, { destFolder, paths, mode }) => {
    const results = [];
    try {
      if (!destFolder || !fs.statSync(destFolder).isDirectory()) {
        return { ok: false, error: 'Folder not found', results };
      }
    } catch { return { ok: false, error: 'Folder not found', results }; }
    const destLower = path.resolve(destFolder).toLowerCase();
    for (const src of (paths || []).filter(Boolean)) {
      try {
        if (!fs.existsSync(src)) { results.push({ src, ok: false, error: 'Missing' }); continue; }
        const sameFolder = path.resolve(path.dirname(src)).toLowerCase() === destLower;
        if (mode === 'move' && sameFolder) { results.push({ src, ok: true, skipped: true }); continue; }
        const dest = uniqueDest(destFolder, path.basename(src));
        // Guard: refuse to place a folder inside itself or a descendant of itself.
        if (fs.statSync(src).isDirectory()) {
          const rel = path.relative(src, dest);
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            results.push({ src, ok: false, error: 'Cannot place a folder inside itself' });
            continue;
          }
        }
        if (mode === 'move') {
          try {
            fs.renameSync(src, dest);
          } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            await fs.promises.cp(src, dest, { recursive: true }); // cross-volume: copy + remove
            await fs.promises.rm(src, { recursive: true, force: true });
          }
        } else {
          await fs.promises.cp(src, dest, { recursive: true });
        }
        results.push({ src, dest, ok: true });
      } catch (err) {
        results.push({ src, ok: false, error: err.message });
      }
    }
    return { ok: results.some((r) => r.ok), results };
  });

  // Drag a file/folder OUT of a card (to Explorer, another card, the bin, …).
  // Must run synchronously in response to the renderer's dragstart, so it's a
  // one-way send rather than an invoke.
  ipcMain.on('item:startDrag', (e, paths) => {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    try {
      e.sender.startDrag(list.length === 1
        ? { file: list[0], icon: getDragIcon() }
        : { files: list, icon: getDragIcon() });
    } catch (_) { /* ignore */ }
  });

  // ----- recycle bin -----
  ipcMain.handle('recycle:open', () => recycleBin.open());
  ipcMain.handle('recycle:empty', (e) => recycleBin.empty(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('recycle:info', () => recycleBin.query());
  ipcMain.handle('recycle:icon', () => recycleBin.icon());
  ipcMain.handle('app:addRecycle', () => { actions.ensureRecycleSection(); });

  // ----- native menus -----
  ipcMain.handle('menu:item', (e, { id, payload }) => {
    menus.itemMenu(BrowserWindow.fromWebContents(e.sender), id, payload);
  });
  ipcMain.handle('menu:recycle', (e, { x, y }) => {
    menus.recycleMenu(BrowserWindow.fromWebContents(e.sender), x, y);
  });
  ipcMain.handle('menu:header', (e, id) => {
    menus.headerMenu(BrowserWindow.fromWebContents(e.sender), id);
  });

  // ----- settings -----
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_e, patch) => actions.applySettings(patch));
  ipcMain.handle('settings:sections', () =>
    store.listSections().map((s) => ({ id: s.id, title: s.title, type: s.type })));

  // ----- section lifecycle from UI -----
  ipcMain.handle('app:addSection', (_e, type) => actions.addSection(type));
  ipcMain.handle('section:remove', (_e, id) => actions.deleteSection(id));

  // ----- dialogs / config -----
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('config:export', async () => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'desktop-organizer-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(store.getAll(), null, 2));
    return true;
  });

  ipcMain.handle('config:import', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return false;
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      store.replaceAll(data);
      actions.reloadAll();
      return true;
    } catch (e) {
      dialog.showErrorBox('Import failed', e.message);
      return false;
    }
  });

  ipcMain.handle('config:reset', async () => {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Reset everything'],
      defaultId: 0,
      cancelId: 0,
      message: 'Reset all sections and settings to defaults?',
      detail: 'This removes every section. Your real files are never touched.',
    });
    if (r.response !== 1) return false;
    store.replaceAll({});
    actions.reloadAll();
    return true;
  });

  // NB: openSettingsWindow() returns a BrowserWindow, which is NOT structured-
  // cloneable. Returning it through ipcMain.handle throws "An object could not be
  // cloned" in the caller. Swallow the return value — the UI only needs the side
  // effect (the window opening).
  ipcMain.handle('app:openSettings', () => { wm.openSettingsWindow(); });
}

module.exports = { register };
