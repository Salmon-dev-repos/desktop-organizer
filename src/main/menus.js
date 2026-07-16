// Right-click menus for items and section headers.
//
// For file/folder items we show the REAL Windows Explorer context menu (via
// shellMenu). If that native path is unavailable or fails, we fall back to a
// built-in Electron menu so there's always something usable.
const { Menu, shell, clipboard, dialog, screen } = require('electron');
const store = require('./store');
const wm = require('./windowManager');
const actions = require('./actions');
const shellMenu = require('./shellMenu');
const recycleBin = require('./recycleBin');

function isUrl(target) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(target); }

function openTarget(target) {
  if (!target) return;
  if (isUrl(target)) shell.openExternal(target);
  else shell.openPath(target);
}

// DIP (renderer screen coords) -> physical pixels for Win32 menu placement.
function physicalPoint(x, y) {
  try { return screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) }); }
  catch (_) { return { x: Math.round(x), y: Math.round(y) }; }
}

// payload: { paths:[], keys:[], primaryKey, portal, x, y }
function itemMenu(win, sectionId, payload) {
  if (!win || win.isDestroyed()) return;
  const p = payload || {};
  const paths = (p.paths || []).filter((t) => t && !isUrl(t)); // shell menu is filesystem-only
  const pt = physicalPoint(p.x, p.y);

  // Try the real Windows shell menu first (files/folders only).
  if (paths.length && shellMenu.isAvailable()) {
    const r = shellMenu.popup(win, paths, pt.x, pt.y);
    if (r && r.rename && p.primaryKey != null) {
      win.webContents.send('ui:action', { type: 'renameItem', key: p.primaryKey });
      return;
    }
    if (r && r.ok) return;
    // r.ok === false -> fall through to the built-in menu below.
  }
  fallbackItemMenu(win, sectionId, p);
}

// Built-in menu used for URLs and whenever the native shell menu is unavailable.
function fallbackItemMenu(win, sectionId, p) {
  const paths = p.paths || [];
  const primary = paths[0];
  const url = primary && isUrl(primary);
  const template = [
    { label: 'Open', click: () => paths.forEach(openTarget) },
    ...(url ? [] : [{ label: 'Open file location', click: () => shell.showItemInFolder(primary) }]),
    { label: 'Copy path', click: () => clipboard.writeText(paths.join('\r\n')) },
  ];
  if (!url) {
    template.push(
      { type: 'separator' },
      {
        label: paths.length > 1 ? `Delete ${paths.length} items` : 'Delete',
        click: async () => { await recycleBin.deleteToRecycle(paths); },
      },
    );
  }
  if (!p.portal) {
    template.push(
      { type: 'separator' },
      { label: 'Rename label', click: () => { if (p.primaryKey != null) win.webContents.send('ui:action', { type: 'renameItem', key: p.primaryKey }); } },
      {
        label: paths.length > 1 ? 'Remove from section' : 'Remove from section',
        click: () => { (p.keys || []).forEach((k) => store.removeItem(sectionId, k)); wm.pushState(sectionId); },
      },
    );
  }
  Menu.buildFromTemplate(template).popup({ window: win });
}

// Right-click on the Recycle Bin tile -> the bin's real shell menu (Open, Empty
// Recycle Bin, Properties, …), with a built-in fallback.
function recycleMenu(win, x, y) {
  if (!win || win.isDestroyed()) return;
  const pt = physicalPoint(x, y);
  if (shellMenu.isAvailable()) {
    const r = shellMenu.popup(win, [recycleBin.RECYCLE_PARSE], pt.x, pt.y);
    if (r && r.ok) return;
  }
  Menu.buildFromTemplate([
    { label: 'Open Recycle Bin', click: () => recycleBin.open() },
    { label: 'Empty Recycle Bin…', click: () => recycleBin.empty(win) },
  ]).popup({ window: win });
}

function headerMenu(win, sectionId) {
  if (!win || win.isDestroyed()) return;
  const s = store.getSection(sectionId);
  if (!s) return;
  const locked = store.getSettings().locked;
  const template = [];

  if (s.type === 'recycle') {
    template.push({ label: 'Open Recycle Bin', click: () => recycleBin.open() });
    template.push({ label: 'Empty Recycle Bin…', click: () => recycleBin.empty(win) });
    template.push({ type: 'separator' });
    template.push({ label: s.collapsed ? 'Expand' : 'Collapse', click: () => wm.setCollapsed(sectionId, !s.collapsed) });
    template.push(check('Lock all layout', locked, () => actions.toggleLock()));
    template.push({ type: 'separator' });
    template.push({ label: 'App settings…', click: () => wm.openSettingsWindow() });
    template.push({ label: 'Remove Recycle Bin tile', click: () => actions.deleteSection(sectionId) });
    Menu.buildFromTemplate(template).popup({ window: win });
    return;
  }

  if (s.type === 'todo') {
    const v = s.todo || {};
    template.push({ label: 'Add task', click: () => win.webContents.send('ui:action', { type: 'focusAddTodo' }) });
    template.push({ type: 'separator' });
    template.push({
      label: 'Sort by',
      submenu: [
        radio('Manual', (v.sort || 'manual') === 'manual', () => actions.setTodoOpts(sectionId, { sort: 'manual' })),
        radio('Due date', v.sort === 'due', () => actions.setTodoOpts(sectionId, { sort: 'due' })),
        radio('Priority', v.sort === 'priority', () => actions.setTodoOpts(sectionId, { sort: 'priority' })),
        radio('Created', v.sort === 'created', () => actions.setTodoOpts(sectionId, { sort: 'created' })),
        radio('A–Z', v.sort === 'alpha', () => actions.setTodoOpts(sectionId, { sort: 'alpha' })),
      ],
    });
    template.push({
      label: 'Show',
      submenu: [
        radio('Active', (v.filter || 'active') === 'active', () => actions.setTodoOpts(sectionId, { filter: 'active' })),
        radio('All', v.filter === 'all', () => actions.setTodoOpts(sectionId, { filter: 'all' })),
        radio('Completed', v.filter === 'completed', () => actions.setTodoOpts(sectionId, { filter: 'completed' })),
      ],
    });
    template.push({ label: 'Clear completed', click: () => { store.clearCompleted(sectionId); wm.pushState(sectionId); } });
    template.push({ type: 'separator' });
    template.push({ label: 'Rename list', click: () => win.webContents.send('ui:action', { type: 'renameSection' }) });
    template.push({ label: s.collapsed ? 'Expand' : 'Collapse', click: () => wm.setCollapsed(sectionId, !s.collapsed) });
    template.push(check('Lock all layout', locked, () => actions.toggleLock()));
    template.push({ type: 'separator' });
    template.push({ label: 'App settings…', click: () => wm.openSettingsWindow() });
    template.push({ label: 'Delete list', click: () => actions.deleteSection(sectionId) });
    Menu.buildFromTemplate(template).popup({ window: win });
    return;
  }

  if (s.type === 'bucket') {
    template.push({
      label: 'Add files…',
      click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
        if (!r.canceled && r.filePaths.length) { store.addItems(sectionId, r.filePaths); wm.pushState(sectionId); }
      },
    });
    template.push({
      label: 'Add folder…',
      click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
        if (!r.canceled && r.filePaths.length) { store.addItems(sectionId, r.filePaths); wm.pushState(sectionId); }
      },
    });
  } else {
    template.push({
      label: 'Set folder…',
      click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        if (!r.canceled && r.filePaths.length) actions.setPortalFolder(sectionId, r.filePaths[0]);
      },
    });
    if (s.portal && s.portal.folderPath) {
      template.push({ label: 'Open folder', click: () => shell.openPath(s.portal.folderPath) });
    }
    const p = s.portal || {};
    template.push({ type: 'separator' });
    template.push({
      label: 'Sort by',
      submenu: [
        radio('Name', p.sort === 'name' || !p.sort, () => actions.setPortalOpts(sectionId, { sort: 'name' })),
        radio('Date modified', p.sort === 'date', () => actions.setPortalOpts(sectionId, { sort: 'date' })),
        radio('Type', p.sort === 'type', () => actions.setPortalOpts(sectionId, { sort: 'type' })),
      ],
    });
    template.push(check('Folders first', p.foldersFirst !== false, () => actions.setPortalOpts(sectionId, { foldersFirst: !(p.foldersFirst !== false) })));
    template.push(check('Show hidden', !!p.showHidden, () => actions.setPortalOpts(sectionId, { showHidden: !p.showHidden })));
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Rename section', click: () => win.webContents.send('ui:action', { type: 'renameSection' }) });
  template.push({ label: s.collapsed ? 'Expand' : 'Collapse', click: () => wm.setCollapsed(sectionId, !s.collapsed) });
  template.push(check('Lock all layout', locked, () => actions.toggleLock()));
  template.push({ type: 'separator' });
  template.push({ label: 'App settings…', click: () => wm.openSettingsWindow() });
  template.push({ label: 'Delete section', click: () => actions.deleteSection(sectionId) });

  Menu.buildFromTemplate(template).popup({ window: win });
}

function radio(label, checked, click) { return { label, type: 'radio', checked: !!checked, click }; }
function check(label, checked, click) { return { label, type: 'checkbox', checked: !!checked, click }; }

module.exports = { itemMenu, headerMenu, recycleMenu, openTarget };
