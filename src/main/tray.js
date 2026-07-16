// System-tray icon + menu. Returns a rebuild() function so other modules can
// refresh checkbox state after changing settings.
const { Tray, Menu, nativeImage, dialog, app } = require('electron');
const path = require('path');
const store = require('./store');
const wm = require('./windowManager');
const actions = require('./actions');
const autostart = require('./autostart');
const displayManager = require('./displayManager');

let tray = null;
let visible = true;

function trayImage() {
  const p = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img;
}

async function pickFolder() {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}

function rebuild() {
  if (!tray) return;
  const st = store.getSettings();
  const template = [
    {
      label: 'Add section',
      submenu: [
        { label: 'To-do list', click: () => actions.addSection('todo') },
        { label: 'Bucket  (drag files in)', click: () => actions.addSection('bucket') },
        {
          label: 'Folder portal…',
          click: async () => {
            const folder = await pickFolder();
            if (folder) {
              const s = actions.addSection('portal');
              actions.setPortalFolder(s.id, folder);
            }
          },
        },
        { type: 'separator' },
        { label: 'Recycle Bin tile', click: () => actions.ensureRecycleSection() },
      ],
    },
    { type: 'separator' },
    {
      label: 'Hide Windows desktop icons',
      type: 'checkbox',
      checked: st.hideDesktopIcons,
      click: () => actions.setHideDesktopIcons(!st.hideDesktopIcons),
    },
    { label: 'Lock layout', type: 'checkbox', checked: st.locked, click: () => actions.toggleLock() },
    {
      label: visible ? 'Hide all sections' : 'Show all sections',
      click: () => { visible = !visible; wm.setVisibleAll(visible); rebuild(); },
    },
    {
      label: 'Embed in desktop (experimental)',
      type: 'checkbox',
      checked: st.embedInDesktop,
      click: () => actions.setEmbed(!st.embedInDesktop),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => wm.openSettingsWindow() },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostart.getLaunchAtLogin(),
      click: () => actions.setLaunchAtLogin(!autostart.getLaunchAtLogin()),
    },
    ...(!app.isPackaged ? [
      { type: 'separator' },
      {
        label: 'Developer',
        submenu: [
          { label: 'Simulate undock (laptop only)', click: () => displayManager.simulate('undock') },
          { label: 'Simulate redock', click: () => displayManager.simulate('redock') },
        ],
      },
    ] : []),
    { type: 'separator' },
    { label: 'Quit Desktop Organizer', click: () => { app.isQuiting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip('Desktop Organizer');
}

function create() {
  tray = new Tray(trayImage());
  rebuild();
  // Left-click opens settings; right-click shows the menu (Windows default).
  tray.on('click', () => wm.openSettingsWindow());
  return rebuild;
}

module.exports = { create };
