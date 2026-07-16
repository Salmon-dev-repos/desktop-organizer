// Watches the monitor configuration and keeps cards visible + faithful to the
// canonical (docked) layout. On undock, orphaned cards are auto-tidied onto the
// laptop screen (transient, never saved); on redock they snap back exactly.
const { screen } = require('electron');
const store = require('./store');
const wm = require('./windowManager');
const layout = require('./displayLayout');

const DEBOUNCE_MS = 300; // docking fires a burst of display events; collapse them

let started = false;
let debounceTimer = null;
let lastSignature = '';

// Stable string identifying a display configuration, so we can skip no-op churn.
function signatureOf(displays) {
  return displays
    .map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}`)
    .sort()
    .join('|');
}

// Where to tidy orphaned cards: the OS primary display, falling back to whatever
// display is actually in the given set (simulate('undock') passes a subset).
// NOTE (spec open question): swap to "largest remaining display" here if the
// laptop panel is not the Windows primary while docked.
function reflowArea(displays) {
  const primary = screen.getPrimaryDisplay();
  const target = displays.find((d) => d.id === primary.id) || displays[0] || primary;
  return target.workArea;
}

function reconcile(displays, opts = {}) {
  const list = displays || screen.getAllDisplays();
  const sig = signatureOf(list);
  if (!opts.force && sig === lastSignature) return;
  wm.beginSettling(); // guard the moves we're about to make from being persisted
  const plan = layout.reconcilePlan({
    sections: store.listSections(),
    displays: list,
    displaced: wm.displacedIds(),
    primaryWorkArea: reflowArea(list),
  });
  for (const r of plan.restore) wm.restoreCanonical(r.id);
  for (const r of plan.reflow) wm.applyTransientBounds(r.id, r.bounds);
  lastSignature = sig;
}

function onDisplayEvent() {
  wm.beginSettling(); // synchronous: stop OS-forced moves from being persisted
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => reconcile(), DEBOUNCE_MS);
}

function start() {
  if (started) return;
  started = true;
  screen.on('display-added', onDisplayEvent);
  screen.on('display-removed', onDisplayEvent);
  screen.on('display-metrics-changed', onDisplayEvent);
  // Initial pass covers launching while already undocked. Delayed so section
  // windows (opened asynchronously) exist; reconcile is idempotent regardless.
  setTimeout(() => reconcile(undefined, { force: true }), 500);
}

// Dev/test trigger — drive the whole flow without unplugging hardware.
function simulate(mode) {
  wm.beginSettling();
  if (mode === 'undock') reconcile([screen.getPrimaryDisplay()], { force: true });
  else reconcile(screen.getAllDisplays(), { force: true });
}

module.exports = { start, simulate };
