const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeApp: () => ipcRenderer.invoke('close-app'),
  minimizeApp: () => ipcRenderer.invoke('minimize-app'),
  loadPersonas: () => ipcRenderer.invoke('load-personas'),
  savePersonas: (data) => ipcRenderer.invoke('save-personas', data)
});
