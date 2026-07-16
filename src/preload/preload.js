// Secure bridge: the renderers get a minimal, explicit `window.api` only.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
function on(channel, cb) {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // --- section state ---
  getSection: (id) => invoke('section:get', id),
  getBounds: (id) => invoke('section:getBounds', id),
  setTitle: (id, title) => invoke('section:setTitle', { id, title }),
  setCollapsed: (id, collapsed) => invoke('section:setCollapsed', { id, collapsed }),
  setBounds: (id, bounds) => invoke('section:setBounds', { id, bounds }),
  removeSection: (id) => invoke('section:remove', id),

  // --- bucket items ---
  addItems: (id, paths) => invoke('section:addItems', { id, paths }),
  removeItem: (id, itemId) => invoke('section:removeItem', { id, itemId }),
  renameItem: (id, itemId, label) => invoke('section:renameItem', { id, itemId, label }),

  // --- portals ---
  listPortal: (id) => invoke('portal:list', id),
  setPortalFolder: (id, folder) => invoke('section:setPortalFolder', { id, folder }),

  // --- todos ---
  addTodo: (id, text, fields) => invoke('todo:add', { id, text, fields }),
  patchTodo: (id, todoId, patch) => invoke('todo:patch', { id, todoId, patch }),
  toggleTodo: (id, todoId) => invoke('todo:toggle', { id, todoId }),
  removeTodo: (id, todoId) => invoke('todo:remove', { id, todoId }),
  reorderTodos: (id, orderedIds) => invoke('todo:reorder', { id, orderedIds }),
  clearCompletedTodos: (id) => invoke('todo:clearDone', id),
  setTodoConfig: (id, patch) => invoke('todo:setConfig', { id, patch }),
  addTag: (id, name, color) => invoke('todo:addTag', { id, name, color }),
  removeTag: (id, tagId) => invoke('todo:removeTag', { id, tagId }),

  // --- open / icons / menus ---
  openItem: (target) => invoke('item:open', target),
  reveal: (target) => invoke('item:reveal', target),
  getIcon: (p) => invoke('icon:get', p),
  itemMenu: (id, payload) => invoke('menu:item', { id, payload }),
  headerMenu: (id) => invoke('menu:header', id),

  // --- native file operations ---
  deleteItems: (paths) => invoke('item:delete', paths),
  renameFile: (oldPath, newName) => invoke('fs:rename', { oldPath, newName }),
  dropIntoFolder: (destFolder, paths, mode) => invoke('fs:dropInto', { destFolder, paths, mode }),
  startDrag: (paths) => ipcRenderer.send('item:startDrag', paths),

  // --- recycle bin ---
  recycleMenu: (x, y) => invoke('menu:recycle', { x, y }),
  recycleOpen: () => invoke('recycle:open'),
  recycleEmpty: () => invoke('recycle:empty'),
  recycleInfo: () => invoke('recycle:info'),
  recycleIcon: () => invoke('recycle:icon'),
  addRecycle: () => invoke('app:addRecycle'),

  // --- settings / config ---
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  listSections: () => invoke('settings:sections'),
  addSection: (type) => invoke('app:addSection', type),
  pickFolder: () => invoke('dialog:pickFolder'),
  exportConfig: () => invoke('config:export'),
  importConfig: () => invoke('config:import'),
  resetConfig: () => invoke('config:reset'),
  openSettings: () => invoke('app:openSettings'),

  // --- Explorer drag/drop path resolution (Electron 30+) ---
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  // --- events from main ---
  onState: (cb) => on('section:state', cb),
  onSettings: (cb) => on('settings:changed', cb),
  onLock: (cb) => on('lock:changed', cb),
  onPortal: (cb) => on('portal:update', cb),
  onUiAction: (cb) => on('ui:action', cb),
  onSectionsChanged: (cb) => on('sections:changed', cb),
  onTodoHighlight: (cb) => on('todo:highlight', cb),
});
