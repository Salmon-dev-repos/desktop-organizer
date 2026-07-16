// High-level operations shared by IPC handlers, native menus, and the tray,
// so behaviour stays consistent no matter where an action is triggered.
const { screen } = require('electron');
const path = require('path');
const store = require('./store');
const wm = require('./windowManager');
const portal = require('./folderPortal');
const autostart = require('./autostart');
const desktopPin = require('./desktopPin');

let trayRefresh = () => {};
let hotkeyRefresh = () => {};
function setTrayRefresh(fn) { trayRefresh = fn || trayRefresh; }
function setHotkeyRefresh(fn) { hotkeyRefresh = fn || hotkeyRefresh; }

function defaultBounds(type) {
  const area = screen.getPrimaryDisplay().workArea;
  const n = store.listSections().length;
  const off = (n % 6) * 28;
  // A to-do list is a tall vertical layout, so it gets a taller default footprint.
  const width = type === 'todo' ? 340 : 320;
  const height = type === 'todo' ? 400 : 260;
  return { x: area.x + 90 + off, y: area.y + 90 + off, width, height };
}

function addSection(type, bounds) {
  const s = store.createSection(type, bounds || defaultBounds(type));
  wm.createSectionWindow(s);
  if (type === 'portal') portal.watch(s.id);
  wm.broadcast('sections:changed');
  trayRefresh();
  return s;
}

// A compact tile parked in the top-right of the work area.
function defaultRecycleBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 150, y: area.y + 40, width: 120, height: 150 };
}

// Ensure the single Recycle Bin tile exists (creates it if missing). Returns it.
function ensureRecycleSection() {
  const existing = store.getRecycleSection();
  if (existing) return existing;
  const s = store.createSection('recycle', defaultRecycleBounds());
  wm.createSectionWindow(s);
  wm.broadcast('sections:changed');
  trayRefresh();
  return s;
}

function deleteSection(id) {
  portal.unwatch(id);
  wm.closeSectionWindow(id);
  store.removeSection(id);
  wm.broadcast('sections:changed');
  trayRefresh();
}

function setPortalFolder(id, folder) {
  const s = store.getSection(id);
  if (!s) return;
  const prev = s.portal || {};
  const portalCfg = {
    folderPath: folder,
    sort: prev.sort || 'name',
    foldersFirst: prev.foldersFirst !== false,
    showHidden: !!prev.showHidden,
  };
  const patch = { portal: portalCfg };
  if (!s.title || s.title === 'Folder') patch.title = path.basename(folder) || 'Folder';
  store.patchSection(id, patch);
  portal.watch(id);
  portal.pushList(id);
  wm.pushState(id);
  wm.broadcast('sections:changed');
}

function setPortalOpts(id, patch) {
  const s = store.getSection(id);
  if (!s || !s.portal) return;
  store.patchSection(id, { portal: { ...s.portal, ...patch } });
  portal.watch(id);
  portal.pushList(id);
  wm.pushState(id);
}

// Merge a patch into a to-do list's view config (sort/filter/showCompleted/…).
function setTodoOpts(id, patch) {
  const s = store.getSection(id);
  if (!s || s.type !== 'todo') return;
  store.setTodoConfig(id, patch);
  wm.pushState(id);
}

function setLock(locked) {
  store.setSettings({ locked });
  wm.broadcast('lock:changed', locked);
  wm.broadcast('settings:changed', store.getSettings());
  trayRefresh();
}
function toggleLock() { setLock(!store.getSettings().locked); }

function setEmbed(embed) {
  store.setSettings({ embedInDesktop: embed });
  wm.reapplyPinAll();
  wm.broadcast('settings:changed', store.getSettings());
  trayRefresh();
}

function setLaunchAtLogin(v) {
  autostart.setLaunchAtLogin(v);
  store.setSettings({ launchAtLogin: v });
  trayRefresh();
}

// Hide/show the real Windows desktop icons (removes the "duplicate" icons
// showing behind the cards). Returns whether the native call succeeded.
function setHideDesktopIcons(hide) {
  const ok = desktopPin.setIconsVisible(!hide);
  store.setSettings({ hideDesktopIcons: hide });
  // Hiding the real icons also hides the real Recycle Bin — give it back.
  if (hide) ensureRecycleSection();
  wm.broadcast('settings:changed', store.getSettings());
  trayRefresh();
  return ok;
}
function applyDesktopIconsSetting() {
  if (store.getSettings().hideDesktopIcons) desktopPin.setIconsVisible(false);
}
function restoreDesktopIcons() {
  if (store.getSettings().hideDesktopIcons) desktopPin.setIconsVisible(true);
}

// Apply an arbitrary settings patch and run any needed side effects.
function applySettings(patch) {
  const before = store.getSettings();
  const next = store.setSettings(patch);
  const changed = (k) => k in patch && patch[k] !== before[k];
  if (changed('embedInDesktop')) wm.reapplyPinAll();
  if (changed('hideDesktopIcons')) {
    desktopPin.setIconsVisible(!next.hideDesktopIcons);
    if (next.hideDesktopIcons) ensureRecycleSection();
  }
  if (changed('launchAtLogin')) autostart.setLaunchAtLogin(next.launchAtLogin);
  if (changed('locked')) wm.broadcast('lock:changed', next.locked);
  if (changed('hotkeyToggleLock')) hotkeyRefresh();
  wm.broadcast('settings:changed', next);
  trayRefresh();
  return next;
}

// Rebuild the whole widget layer from the current store (after import/reset).
function reloadAll() {
  portal.stopAll();
  for (const id of wm.allIds()) wm.closeSectionWindow(id);
  for (const s of store.listSections()) wm.createSectionWindow(s);
  portal.startAll();
  const settings = store.getSettings();
  wm.broadcast('settings:changed', settings);
  wm.broadcast('lock:changed', settings.locked);
  wm.broadcast('sections:changed');
  trayRefresh();
}

module.exports = {
  setTrayRefresh, setHotkeyRefresh,
  addSection, deleteSection, ensureRecycleSection,
  setPortalFolder, setPortalOpts, setTodoOpts,
  setLock, toggleLock, setEmbed, setLaunchAtLogin,
  setHideDesktopIcons, applyDesktopIconsSetting, restoreDesktopIcons,
  applySettings, reloadAll,
};
