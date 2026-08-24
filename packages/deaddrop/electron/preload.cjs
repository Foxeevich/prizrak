const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dd', { status: () => ipcRenderer.invoke('dd-status') });
