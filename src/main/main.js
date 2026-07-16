// App entry: single-instance lock, lifecycle, wiring of every module.
const { app, globalShortcut, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const desktopPin = require('./desktopPin');
const wm = require('./windowManager');
const portal = require('./folderPortal');
const displayManager = require('./displayManager');
const actions = require('./actions');
const ipc = require('./ipc');
const tray = require('./tray');
const autostart = require('./autostart');
const reminders = require('./reminders');

// Only one copy of the widget layer may run.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Must match the electron-builder appId so Windows attributes toast
  // notifications to this app (and they persist in Action Center).
  app.setAppUserModelId('com.jacob.desktoporganizer');

  app.on('second-instance', () => wm.openSettingsWindow());

  // Keep a stray error from spamming modal "A JavaScript error occurred" dialogs
  // or killing the tray app — log it (to console + %APPDATA%\desktop-organizer\error.log).
  process.on('uncaughtException', (e) => logError('[UNCAUGHT]', (e && e.stack) || e));
  process.on('unhandledRejection', (e) => logError('[UNHANDLED]', (e && e.stack) || e));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message, line, source) => {
      if (level >= 2) logError('[RENDERER]', `${message} (${source}:${line})`);
    });
    wc.on('preload-error', (_ev, p, err) => logError('[PRELOAD-ERROR]', `${p} ${(err && err.stack) || err}`));
    wc.on('render-process-gone', (_ev, d) => logError('[RENDER-GONE]', JSON.stringify(d)));
  });

  // Transparent widget windows render more reliably with GPU compositing on;
  // keep defaults but disable the background-throttle so portals stay live.
  app.commandLine.appendSwitch('disable-background-timer-throttling');

  // ---- Memory trims (safe: none affect transparency / GPU compositing) ----
  // Local-only widget app: no web browsing, extensions, translation, media
  // casting or telemetry to service. Turn off Chromium subsystems that reserve
  // memory + background threads for features we never use.
  app.commandLine.appendSwitch('disable-features',
    'Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion');
  // Cap V8's per-isolate heap so each process (main + every renderer) reserves
  // far less. --max-semi-space-size shrinks the young-generation scratch space
  // (default up to 16 MB → 2 MB); --max-old-space-size is a generous ceiling we
  // never approach. Trades a touch more GC frequency for a smaller footprint.
  app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=2 --max-old-space-size=192');

  app.whenReady().then(start);

  // Tray app: closing all windows must NOT quit.
  app.on('window-all-closed', (e) => { /* keep running in tray */ });
  app.on('will-quit', () => {
    wm.setQuitting(); // suppress the shared-renderer crash-rebuild during shutdown
    globalShortcut.unregisterAll();
    reminders.stop();
    portal.stopAll();
    // Never leave the user's real desktop icons hidden after we exit.
    actions.restoreDesktopIcons();
  });
}

function start() {
  desktopPin.init();
  ipc.register();

  // Self-heal the "start with Windows" login item on every launch: re-register
  // it so the command always points at THIS install path. Without this, an
  // unpackaged build's login entry can go stale (bare electron.exe with no app
  // path, or an old folder location) and silently stop launching on boot.
  if (store.getSettings().launchAtLogin) autostart.setLaunchAtLogin(true);

  // First run: seed one welcome bucket so the desktop isn't empty.
  if (store.listSections().length === 0) seedWelcome();

  for (const s of store.listSections()) wm.createSectionWindow(s);
  portal.startAll();
  displayManager.start();

  // Re-apply the "hide desktop icons" preference from last session.
  actions.applyDesktopIconsSetting();

  const rebuildTray = tray.create();
  actions.setTrayRefresh(rebuildTray);
  actions.setHotkeyRefresh(registerHotkey);
  registerHotkey();

  reminders.start();
}

function logError(tag, detail) {
  console.error(tag, detail);
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'error.log'),
      `[${new Date().toISOString()}] ${tag} ${detail}\n`
    );
  } catch (_) { /* logging must never throw */ }
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = store.getSettings().hotkeyToggleLock;
  if (!key) return;
  try {
    globalShortcut.register(key, () => actions.toggleLock());
  } catch (_) { /* invalid accelerator — ignore */ }
}

function seedWelcome() {
  const area = screen.getPrimaryDisplay().workArea;
  const s = store.createSection('bucket', { x: area.x + 90, y: area.y + 90, width: 340, height: 280 });
  store.patchSection(s.id, { title: 'My Section' });
}
