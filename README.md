# Desktop Organizer

A sleek, non-intrusive desktop overlay for **Windows 10/11** that organizes your
desktop into professional-looking **acrylic-glass sections** — a modern, personal
take on Stardock Fences. Each section is its own translucent card that holds
shortcuts to your folders, files, and apps. Everything is **shortcut-based**: your
real files are never moved or deleted.

## Features

- **Section types**
  - **Bucket** — drag files / folders / apps from Explorer to add shortcuts.
  - **Folder portal** — mirrors a real folder's contents live (auto-refreshes).
  - **Recycle Bin** — a tile that opens the real bin, shows its empty/full icon +
    item count, and accepts dropped files to delete. Appears automatically when
    you hide the Windows desktop icons (add/remove it anytime from the tray).
- **Real Windows right-click** — right-clicking an item shows the *actual*
  Windows Explorer context menu (Open with, Cut/Copy/Paste, Delete → Recycle Bin,
  Send to, Properties, and every third-party shell extension). Drag files out to
  Explorer or another card, and use `Delete` / `F2` / `Enter` / `Ctrl+A` /
  multi-select just like on the desktop. In a folder portal, right-clicking empty
  space gives the folder's own menu (Paste, New, …).
- **Sleek & movable** — frameless acrylic-glass cards, drag by the header, resize
  from any edge/corner, collapse to just the title bar.
- **Non-intrusive** — cards sit on the desktop and sink below your active apps, so
  the rest of your desktop stays fully usable.
- **Highly configurable** — theme (dark / light / auto), accent color, opacity,
  corner radius, icon size, grid snapping, and more, applied live.
- **Tray-managed** — add sections, lock the layout, hide/show all, start with
  Windows, and a global hotkey to lock/unlock (default `Ctrl+Alt+L`).
- **Persistent** — layout and shortcuts are saved and restored between launches.
- **Monitor-aware** — undock a laptop and cards from a disconnected monitor
  auto-tidy onto the remaining screen; redock and every card snaps back to its
  exact saved position. Your layout is never lost on a monitor change.

## Run it (development)

```powershell
npm install
npm run make-icons   # generates the tray + app icons (also run automatically before build)
npm run dev
```

A welcome section appears on your desktop. Manage everything from the **tray icon**
(bottom-right, near the clock) — right-click it for the menu, left-click to open
Settings.

## Build an installer

```powershell
npm run build          # NSIS installer + portable .exe in dist/
npm run build:portable # portable .exe only
```

## Making it feel "part of the desktop"

Because the app is a **standalone widget layer**, your real Windows desktop icons
are left untouched — which means a file you drag into a section still shows as its
original icon on the desktop *behind* the card (a duplicate). To get the clean,
Fences-like result:

1. **Tray → "Hide Windows desktop icons"** (or Settings → Behavior). This hides the
   real desktop icons so there are no duplicates — your sections become the desktop.
   A **Recycle Bin tile** is added automatically so you never lose access to it.
   The app **automatically restores your icons when you quit**, and re-hides them on
   next launch. (If it ever exits abnormally, right-click the desktop → *View → Show
   desktop icons* to bring them back.)
2. Optionally enable **Tray → "Embed in desktop (experimental)"** to glue the cards
   to the wallpaper layer so they survive <kbd>Win</kbd>+<kbd>D</kbd> (Show Desktop).

## How it stays on the desktop

By default each card is a floating widget that **sinks below your active apps** on
blur — rock-solid on every setup. The **"Embed in desktop"** mode glues cards to the
Windows wallpaper layer so they survive <kbd>Win</kbd>+<kbd>D</kbd>. Embedding uses a
native Win32 call and is machine-dependent; if it ever misbehaves (e.g. multi-monitor
with offset origins), just turn it back off — the app keeps working as floating widgets.

## Notes

- **Glass look** is rendered in CSS, so it looks identical on Windows 10 and 11.
  (True DWM "native acrylic" isn't used — it's incompatible with the transparent,
  fully-rounded card windows this app relies on.)
- **Config file:** `%APPDATA%\desktop-organizer\config.json` — export/import/reset
  from Settings → *Configuration*.
- **Something breaks?** Errors are logged to
  `%APPDATA%\desktop-organizer\error.log` — send me that file to diagnose.

## Project layout

```
src/main/       Electron main process (windows, tray, store, portals, desktop pin,
                native shell context menu + recycle bin via koffi/COM)
src/preload/    Secure contextBridge API
src/renderer/   Section card + Settings UIs
assets/         Generated icons (makeIcons.js)
```
"# desktop-organizer" 
