// 只暴露界面需要的几个桌面功能：选择文件夹、主题。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (t) => ipcRenderer.invoke('set-theme', t),
});
