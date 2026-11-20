'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminSetup', {
  submit(username, password, confirmPassword) {
    return ipcRenderer.invoke('admin-setup:submit', {
      username,
      password,
      confirmPassword,
    });
  },
  cancel() {
    ipcRenderer.send('admin-setup:cancel');
  },
});
