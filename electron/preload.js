'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tally', {
  snapshot: () => ipcRenderer.invoke('tally:snapshot'),
  range: (days) => ipcRenderer.invoke('tally:range', days),
  updateSettings: (patch) => ipcRenderer.invoke('tally:settings:update', patch),
  clearData: () => ipcRenderer.invoke('tally:clear'),
  openDataFolder: () => ipcRenderer.invoke('tally:open-data-folder'),
  rescanBrowsers: () => ipcRenderer.invoke('tally:browsers:rescan'),
  requestAccessibility: () => ipcRenderer.invoke('tally:permissions:accessibility'),
  installUpdate: () => ipcRenderer.invoke('tally:update:install'),
  checkForUpdates: () => ipcRenderer.invoke('tally:update:check'),
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tally:changed', listener);
    return () => ipcRenderer.removeListener('tally:changed', listener);
  },
});
