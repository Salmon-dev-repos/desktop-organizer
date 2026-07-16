// To-do reminder scheduler. A single periodic tick scans every to-do section for
// due reminders and fires a native Windows toast. A tick-scan (not one setTimeout
// per task) is deliberate: setTimeout clamps delays > ~24.8 days (2^31 ms) and
// would misfire far-future reminders; re-reading the store each tick also makes
// edits/deletes/snoozes/import and system sleep + clock/DST changes correct for
// free — both sides of the `remindAt <= now` compare are absolute epoch ms.
const { Notification, powerMonitor } = require('electron');
const store = require('./store');
const wm = require('./windowManager');

const TICK_MS = 20000;
let timer = null;
let started = false;

function start() {
  if (started) return;
  started = true;
  fireDue(true); // catch reminders missed while the app was closed
  timer = setInterval(() => fireDue(false), TICK_MS);
  try { powerMonitor.on('resume', () => fireDue(false)); } catch (_) { /* not fatal */ }
}

function stop() {
  clearInterval(timer);
  timer = null;
  started = false;
}

// Immediate pass — called after a todo mutation so a "remind in 20s" isn't
// delayed up to a full tick. No-op until start() has run.
function rescan() { if (started) fireDue(false); }

function fireDue(isLaunch) {
  const settings = store.getSettings();
  if (!settings.remindersEnabled) return;
  const supported = Notification.isSupported();
  const now = Date.now();
  const missed = []; // launch-time coalescing

  for (const sec of store.listTodoSections()) {
    let changed = false;
    for (const t of sec.todos || []) {
      if (t.done || t.remindAt == null) continue;
      if (t.reminderFiredAt != null && t.reminderFiredAt >= t.remindAt) continue; // already fired
      if (t.remindAt > now) continue;
      if (isLaunch) missed.push({ sec, t });
      else if (supported) notify(sec, t, settings, { overdue: false });
      t.reminderFiredAt = now;
      changed = true;
    }
    if (changed) { store.upsertSection(sec); wm.pushState(sec.id); }
  }

  if (isLaunch) flushMissed(missed, supported, settings);
}

// On launch, a pile of overdue reminders would be a toast storm — collapse more
// than a few into a single summary. Each still gets its firedAt stamped above.
function flushMissed(missed, supported, settings) {
  if (!missed.length || !supported) return;
  if (missed.length > 3) {
    const n = new Notification({
      title: 'To-Do reminders',
      body: `${missed.length} reminders are overdue`,
      silent: !settings.reminderSound,
    });
    n.on('click', () => wm.focusSection(missed[0].sec.id));
    n.show();
    return;
  }
  for (const { sec, t } of missed) notify(sec, t, settings, { overdue: true });
}

function notify(sec, t, settings, { overdue }) {
  const body = [dueLabel(t), sec.title || 'To-Do'].filter(Boolean).join('  ·  ');
  const n = new Notification({
    title: t.text || 'Task',
    body: (overdue ? 'Overdue — ' : '') + body,
    silent: !settings.reminderSound,
    // Action buttons are best-effort on Windows (reliable only in an installed
    // build with a registered toast activator); the click handler always works.
    actions: [
      { type: 'button', text: 'Mark done' },
      { type: 'button', text: 'Snooze 10 min' },
    ],
  });
  n.on('click', () => {
    wm.focusSection(sec.id);
    wm.send(sec.id, 'todo:highlight', t.id);
  });
  n.on('action', (_e, index) => {
    if (index === 0) { store.toggleTodo(sec.id, t.id); wm.pushState(sec.id); }
    else if (index === 1) {
      store.patchTodo(sec.id, t.id, { remindAt: Date.now() + 10 * 60 * 1000, reminderFiredAt: null });
      wm.pushState(sec.id);
    }
  });
  n.show();
}

function dueLabel(t) {
  if (t.due == null) return '';
  try {
    const d = new Date(t.due);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (!t.dueHasTime) return date;
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${date} ${time}`;
  } catch (_) { return ''; }
}

module.exports = { start, stop, rescan };
