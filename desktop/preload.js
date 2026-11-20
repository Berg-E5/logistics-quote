'use strict';

const { clipboard, contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminSetup', {
  submit(payload) {
    return ipcRenderer.invoke('admin-setup:submit', payload || {});
  },
  cancel() {
    ipcRenderer.send('admin-setup:cancel');
  },
});

contextBridge.exposeInMainWorld('connectionPage', {
  retry() {
    ipcRenderer.send('connection:retry');
  },
  settings() {
    ipcRenderer.send('connection:settings');
  },
  copyServer(text) {
    clipboard.writeText(String(text || ''));
  },
});
