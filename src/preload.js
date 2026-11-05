const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kopru', {
  on: (name, fn) => ipcRenderer.on(name, (_e, data) => fn(data)),
  send: (name, data) => ipcRenderer.send(name, data),
  invoke: (name, data) => ipcRenderer.invoke(name, data),
});
