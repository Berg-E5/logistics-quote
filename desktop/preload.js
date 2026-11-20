'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminSetup', {
  submit(payload) {
    return ipcRenderer.invoke('admin-setup:submit', payload || {});
  },
  cancel() {
    ipcRenderer.send('admin-setup:cancel');
  },
});
