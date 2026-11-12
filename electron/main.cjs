// 桌面版入口：在本机起一个只给自己用的服务，再用一个独立窗口显示界面。
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MOCK = process.argv.includes('--mock');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let srv = null;

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: '圆桌',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 外部链接用系统浏览器打开；窗口本身只显示本软件
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); if (/^https?:\/\//i.test(target)) shell.openExternal(target); }
  });
  // F12 打开开发者工具，Ctrl+R 刷新
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
  });
  win.loadURL(url);
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { setFetch } = await import(pathToFileURL(path.join(ROOT, 'src', 'engines', 'http.mjs')).href);
  setFetch((u, opts) => net.fetch(u, opts)); // 走系统代理

  const { startServer } = await import(pathToFileURL(path.join(ROOT, 'src', 'app-server.mjs')).href);
  const canEncrypt = safeStorage.isEncryptionAvailable();
  srv = await startServer({
    port: 0,
    dataDir: path.join(ROOT, MOCK ? 'data-mock' : 'data'),
    mock: MOCK,
    hooks: {
      desktop: true,
      openPath: (p) => shell.openPath(p),
      protect: (s) => (canEncrypt ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s }),
      unprotect: (o) => (o?.enc ? safeStorage.decryptString(Buffer.from(o.enc, 'base64')) : o?.plain || ''),
    },
  });

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择共享文件夹', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  console.log(`圆桌桌面版已启动：${srv.url}`);
  createWindow(srv.url);
}).catch((e) => {
  dialog.showErrorBox('圆桌启动失败', String(e?.stack || e));
  app.quit();
});

app.on('window-all-closed', () => {
  srv?.close();
  app.quit();
});
