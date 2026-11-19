'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminSetup', {
  submit(password, confirmPassword) {
    return ipcRenderer.invoke('admin-setup:submit', {
      password,
      confirmPassword,
    });
  },
  cancel() {
    ipcRenderer.send('admin-setup:cancel');
  },
});
