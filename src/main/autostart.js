// Start-with-Windows wrapper around Electron's login-item API.
const path = require('path');
const { app } = require('electron');

function setLaunchAtLogin(enabled) {
  try {
    // Packaged: process.execPath IS the app .exe, so --hidden alone is enough.
    // Unpackaged (dev): process.execPath is bare electron.exe, which has no idea
    // which app to load — we MUST pass the app directory as the first argument,
    // otherwise the login item becomes `electron.exe --hidden` and nothing starts.
    const args = app.isPackaged
      ? ['--hidden']
      : [path.resolve(app.getAppPath()), '--hidden'];
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args,
    });
  } catch (_) { /* not supported in dev/unsigned contexts — ignore */ }
}

function getLaunchAtLogin() {
  try {
    const s = app.getLoginItemSettings();
    // `openAtLogin` is false for unpackaged builds because we register an extra
    // arg (the app dir), which Electron treats as a "non-standard" entry.
    // `executableWillLaunchAtLogin` ignores args and reports whether the exe
    // will actually run at login with ANY arguments — the truthful state here.
    return s.openAtLogin || s.executableWillLaunchAtLogin || false;
  } catch {
    return false;
  }
}

module.exports = { setLaunchAtLogin, getLaunchAtLogin };
