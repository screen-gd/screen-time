'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focusCover', {
  openApp: () => ipcRenderer.invoke('tally:focus:open-app'),
});
