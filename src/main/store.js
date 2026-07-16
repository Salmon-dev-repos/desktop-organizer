// Persistent config (electron-store, atomic writes) + all section/item CRUD.
const Store = require('electron-store');
const fs = require('fs');
const { randomUUID } = require('crypto');

const DEFAULT_SETTINGS = {
  theme: 'dark',            // dark | light | auto
  accent: '#6ea8fe',
  opacity: 0.82,            // card background opacity (0.4 - 1)
  cornerRadius: 14,
  showItemLabels: true,
  iconSize: 44,
  snapToGrid: false,
  gridSize: 16,
  locked: false,            // layout locked (no move/resize)
  hideDesktopIcons: false,  // hide the real Windows desktop icons (no duplicates)
  embedInDesktop: false,    // WorkerW glue (experimental) vs floating widget
  launchAtLogin: false,
  hotkeyToggleLock: 'Control+Alt+L',
  remindersEnabled: true,   // fire native toast notifications for to-do reminders
  reminderLeadMinutes: 0,   // default lead time before a due date (0 = at due time)
  reminderSound: false,     // play the default Windows sound with reminder toasts
};

const store = new Store({
  name: 'config',
  defaults: { version: 1, settings: DEFAULT_SETTINGS, sections: [] },
});

// Merge in any newly-added default settings keys on upgrade, and drop removed ones.
function ensureSettings() {
  const s = store.get('settings') || {};
  const merged = { ...DEFAULT_SETTINGS, ...s };
  delete merged.nativeAcrylic; // feature removed (incompatible with transparent windows)
  store.set('settings', merged);
}
ensureSettings();

// One-time heal: an earlier embed bug could shrink a card toward the 180x120 floor
// at (0,0). Restore any such section to a usable size/position — runs only once.
function healBoundsOnce() {
  if (store.get('migratedBoundsHealV1')) return;
  const sections = listSections();
  let changed = false;
  for (const sec of sections) {
    const b = sec.bounds || {};
    if (b.width <= 190 && b.height <= 135) { b.width = 340; b.height = 280; changed = true; }
    if ((b.x || 0) <= 0 && (b.y || 0) <= 0) { b.x = 90; b.y = 90; changed = true; }
    sec.bounds = b;
  }
  if (changed) writeSections(sections);
  store.set('migratedBoundsHealV1', true);
}
healBoundsOnce();

// ---------- settings ----------
// Always return a valid object — a missing/corrupt settings key must never crash
// callers doing store.getSettings().someFlag (e.g. window event handlers).
function getSettings() {
  const s = store.get('settings');
  return (s && typeof s === 'object') ? s : { ...DEFAULT_SETTINGS };
}
function setSettings(patch) {
  const next = { ...store.get('settings'), ...patch };
  store.set('settings', next);
  return next;
}

// ---------- sections ----------
function listSections() { return store.get('sections') || []; }
function getSection(id) { return listSections().find((s) => s.id === id) || null; }

function writeSections(sections) { store.set('sections', sections); }

function upsertSection(section) {
  const sections = listSections();
  const idx = sections.findIndex((s) => s.id === section.id);
  if (idx >= 0) sections[idx] = section; else sections.push(section);
  writeSections(sections);
  return section;
}

function patchSection(id, patch) {
  const sections = listSections();
  const idx = sections.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  sections[idx] = { ...sections[idx], ...patch };
  writeSections(sections);
  return sections[idx];
}

function removeSection(id) {
  writeSections(listSections().filter((s) => s.id !== id));
}

const DEFAULT_TITLE = { portal: 'Folder', recycle: 'Recycle Bin', bucket: 'New Section', todo: 'To-Do' };

function createSection(type, bounds) {
  const section = {
    id: randomUUID(),
    title: DEFAULT_TITLE[type] || 'New Section',
    type,
    bounds: bounds || { x: 120, y: 120, width: 300, height: 240 },
    collapsed: false,
    style: { accent: null, opacity: null },
    items: [],
    portal: type === 'portal'
      ? { folderPath: null, sort: 'name', foldersFirst: true, showHidden: false }
      : null,
    // List-level config for a to-do list (mirrors the `portal` namespace).
    todo: type === 'todo'
      ? { sort: 'manual', filter: 'active', tagFilter: null, showCompleted: true, tags: [] }
      : null,
    todos: [], // task objects; array order == manual order
  };
  return upsertSection(section);
}

// The Recycle Bin is a singleton section (at most one on the desktop).
function getRecycleSection() { return listSections().find((s) => s.type === 'recycle') || null; }

// ---------- items (bucket) ----------
function detectKind(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return 'url';
  try {
    return fs.statSync(target).isDirectory() ? 'folder' : 'file';
  } catch {
    return 'file';
  }
}
function labelFor(target, kind) {
  if (kind === 'url') return target.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
  const parts = target.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

function addItems(id, targets) {
  const section = getSection(id);
  if (!section || section.type !== 'bucket') return section;
  const existing = new Set(section.items.map((i) => i.targetPath.toLowerCase()));
  for (const target of targets) {
    if (!target || existing.has(String(target).toLowerCase())) continue;
    const kind = detectKind(target);
    section.items.push({
      id: randomUUID(),
      label: labelFor(target, kind),
      targetPath: target,
      kind,
      addedAt: 0,
    });
    existing.add(String(target).toLowerCase());
  }
  return upsertSection(section);
}

function removeItem(id, itemId) {
  const section = getSection(id);
  if (!section) return section;
  section.items = (section.items || []).filter((i) => i.id !== itemId);
  return upsertSection(section);
}

function renameItem(id, itemId, label) {
  const section = getSection(id);
  if (!section) return section;
  const item = (section.items || []).find((i) => i.id === itemId);
  if (item) item.label = label;
  return upsertSection(section);
}

// ---------- todos ----------
// A to-do section keeps its tasks in `section.todos` and list-level config in
// `section.todo`. Helpers mirror the bucket-item helpers: mutate then upsert.
function nextOrder(section) {
  const todos = section.todos || [];
  return todos.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1;
}

function newTodo(fields) {
  return {
    id: randomUUID(),
    text: '',
    done: false,
    priority: 'none',      // none | low | med | high
    due: null,             // epoch ms, or null
    dueHasTime: false,
    remindAt: null,        // epoch ms to fire the reminder, or null
    reminderFiredAt: null, // guard so a reminder fires once
    notes: '',
    tags: [],              // [tagId]
    subtasks: [],          // [{ id, text, done }]
    recurrence: null,      // null | { freq: 'daily'|'weekdays'|'weekly'|'monthly', interval }
    createdAt: Date.now(),
    completedAt: null,
    order: 0,
    ...fields,
  };
}

function addTodo(id, fields) {
  const section = getSection(id);
  if (!section || section.type !== 'todo') return section;
  section.todos = section.todos || [];
  section.todos.push(newTodo({ ...fields, order: nextOrder(section) }));
  return upsertSection(section);
}

function findTodo(section, todoId) {
  return (section.todos || []).find((t) => t.id === todoId) || null;
}

function patchTodo(id, todoId, patch) {
  const section = getSection(id);
  if (!section) return section;
  const t = findTodo(section, todoId);
  if (!t) return section;
  Object.assign(t, patch);
  // Rescheduling a reminder re-arms it, so the scheduler fires again.
  if ('remindAt' in patch) t.reminderFiredAt = null;
  return upsertSection(section);
}

function removeTodo(id, todoId) {
  const section = getSection(id);
  if (!section) return section;
  section.todos = (section.todos || []).filter((t) => t.id !== todoId);
  return upsertSection(section);
}

// Advance a recurring task's due/remindAt to the next occurrence, by wall-clock
// components (not fixed ms) so e.g. "9 AM daily" stays 9 AM across DST. The
// reminder's lead time relative to the due date is preserved.
function advanceRecurrence(t) {
  const rec = t.recurrence;
  if (!rec) return false;
  const interval = Math.max(1, rec.interval || 1);
  const lead = (t.due != null && t.remindAt != null) ? t.due - t.remindAt : 0;
  const base = new Date(t.due != null ? t.due : (t.remindAt != null ? t.remindAt : Date.now()));
  switch (rec.freq) {
    case 'weekdays':
      do { base.setDate(base.getDate() + 1); } while (base.getDay() === 0 || base.getDay() === 6);
      break;
    case 'weekly':  base.setDate(base.getDate() + 7 * interval); break;
    case 'monthly': base.setMonth(base.getMonth() + interval); break;
    case 'daily':
    default:        base.setDate(base.getDate() + interval); break;
  }
  const nextMs = base.getTime();
  if (t.due != null) t.due = nextMs;
  t.remindAt = (t.remindAt != null) ? nextMs - lead : t.remindAt;
  t.reminderFiredAt = null;
  t.done = false;
  t.completedAt = null;
  return true;
}

function toggleTodo(id, todoId) {
  const section = getSection(id);
  if (!section) return section;
  const t = findTodo(section, todoId);
  if (!t) return section;
  // Completing a recurring task rolls it forward instead of marking it done.
  if (!t.done && t.recurrence) {
    advanceRecurrence(t);
  } else {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
  }
  return upsertSection(section);
}

function reorderTodos(id, orderedIds) {
  const section = getSection(id);
  if (!section) return section;
  const rank = new Map((orderedIds || []).map((tid, i) => [tid, i]));
  for (const t of section.todos || []) {
    if (rank.has(t.id)) t.order = rank.get(t.id);
  }
  (section.todos || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  return upsertSection(section);
}

function clearCompleted(id) {
  const section = getSection(id);
  if (!section) return section;
  section.todos = (section.todos || []).filter((t) => !t.done);
  return upsertSection(section);
}

function setTodoConfig(id, patch) {
  const section = getSection(id);
  if (!section) return section;
  section.todo = { ...(section.todo || {}), ...patch };
  return upsertSection(section);
}

function addTag(id, { name, color }) {
  const section = getSection(id);
  if (!section) return section;
  section.todo = section.todo || { tags: [] };
  section.todo.tags = section.todo.tags || [];
  const tag = { id: randomUUID(), name: String(name || 'Tag').trim() || 'Tag', color: color || '#6ea8fe' };
  section.todo.tags.push(tag);
  upsertSection(section);
  return tag;
}

function removeTag(id, tagId) {
  const section = getSection(id);
  if (!section) return section;
  if (section.todo && Array.isArray(section.todo.tags)) {
    section.todo.tags = section.todo.tags.filter((t) => t.id !== tagId);
    if (section.todo.tagFilter === tagId) section.todo.tagFilter = null;
  }
  for (const t of section.todos || []) {
    if (Array.isArray(t.tags)) t.tags = t.tags.filter((x) => x !== tagId);
  }
  return upsertSection(section);
}

function listTodoSections() { return listSections().filter((s) => s.type === 'todo'); }

// ---------- import / export ----------
function getAll() { return store.store; }
function replaceAll(data) {
  const settings = { ...DEFAULT_SETTINGS, ...((data && data.settings) || {}) };
  const sections = Array.isArray(data && data.sections) ? data.sections : [];
  store.set('settings', settings);
  store.set('sections', sections);
  store.set('version', 1);
}

module.exports = {
  store,
  DEFAULT_SETTINGS,
  getSettings, setSettings,
  listSections, getSection, upsertSection, patchSection, removeSection,
  createSection, getRecycleSection,
  addItems, removeItem, renameItem,
  addTodo, patchTodo, removeTodo, toggleTodo, reorderTodos, clearCompleted,
  setTodoConfig, addTag, removeTag, listTodoSections,
  getAll, replaceAll,
};
