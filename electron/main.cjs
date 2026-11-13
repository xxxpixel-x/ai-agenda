// 桌面版入口：在本机起一个只给自己用的服务，再用一个独立窗口显示界面。
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MOCK = process.argv.includes('--mock');
const DATA_DIR = path.join(ROOT, MOCK ? 'data-mock' : 'data');
const UI_FILE = path.join(DATA_DIR, 'ui.json'); // 界面偏好（主题）
const THEMES = ['system', 'light', 'dark'];
const readUi = () => { try { return JSON.parse(fs.readFileSync(UI_FILE, 'utf8')); } catch { return {}; } };
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f7');

// 窗口其实由 electron.exe 打开。给它自己的应用身份和图标，任务栏才显示 Agenda，固定到任务栏后也从 Agenda.exe 重新打开
const APP_ID = 'Agenda.Desktop';
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const LAUNCHER = path.join(ROOT, 'Agenda.exe');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

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
    title: 'Agenda',
    icon: ICON,
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: ICON,
      relaunchDisplayName: 'Agenda',
      ...(fs.existsSync(LAUNCHER) ? { relaunchCommand: `"${LAUNCHER}"` } : {}),
    });
  }
  // 外部链接用系统浏览器打开；窗口本身只显示本软件
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); if (/^https?:\/\//i.test(target)) shell.openExternal(target); }
  });
  win.on('focus', () => win.flashFrame(false));
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
  const saved = readUi().theme;
  nativeTheme.themeSource = THEMES.includes(saved) ? saved : 'system';
  const { setFetch } = await import(pathToFileURL(path.join(ROOT, 'src', 'engines', 'http.mjs')).href);
  setFetch((u, opts) => net.fetch(u, opts)); // 走系统代理

  const { startServer } = await import(pathToFileURL(path.join(ROOT, 'src', 'app-server.mjs')).href);
  const canEncrypt = safeStorage.isEncryptionAvailable();
  srv = await startServer({
    port: 0,
    dataDir: DATA_DIR,
    mock: MOCK,
    hooks: {
      desktop: true,
      openPath: (p) => shell.openPath(p),
      // 有命令等你确认：窗口不在前台时让任务栏图标闪烁，切回窗口就停
      attention: () => { if (win && !win.isFocused()) win.flashFrame(true); },
      protect: (s) => (canEncrypt ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s }),
      unprotect: (o) => (o?.enc ? safeStorage.decryptString(Buffer.from(o.enc, 'base64')) : o?.plain || ''),
    },
  });

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择共享文件夹', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('get-theme', () => nativeTheme.themeSource);
  ipcMain.handle('set-theme', (_e, t) => {
    if (!THEMES.includes(t) || nativeTheme.themeSource === t) return;
    nativeTheme.themeSource = t; // 页面里的 prefers-color-scheme 也跟着变
    win?.setBackgroundColor(windowBg());
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(UI_FILE, JSON.stringify({ ...readUi(), theme: t })); } catch { /* 记不住也不影响使用 */ }
  });

  console.log(`Agenda 桌面版已启动：${srv.url}`);
  createWindow(srv.url);
}).catch((e) => {
  dialog.showErrorBox('Agenda 启动失败', String(e?.stack || e));
  app.quit();
});

app.on('window-all-closed', () => {
  srv?.close();
  app.quit();
});
