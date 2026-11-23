// 桌面版入口：在本机起一个只给自己用的服务，再用一个独立窗口显示界面。
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage, Menu, nativeTheme, Notification, powerSaveBlocker, Tray, nativeImage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MOCK = process.argv.includes('--mock');
const apiToken = crypto.randomBytes(32).toString('hex');
const cookieToken = crypto.randomBytes(32).toString('hex');
// 从源码运行时数据放在项目里的 data/；安装版的程序目录是只读的，放到系统的用户数据目录
const DATA_DIR = path.join(app.isPackaged ? app.getPath('userData') : ROOT, MOCK ? 'data-mock' : 'data');

// macOS / Linux 从程序坞或桌面打开时，拿不到终端里配置的 PATH，会找不到 claude、codex 等命令。向登录 shell 要一份补上
if (process.platform !== 'win32') {
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop();
    const dirs = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
    for (const d of shellPath.split(path.delimiter)) if (d) dirs.add(d);
    process.env.PATH = [...dirs].join(path.delimiter);
  } catch { /* 拿不到就用原来的 PATH */ }
}
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
let i18n;
let currentLanguage;
const locales = () => app.getPreferredSystemLanguages?.()?.length ? app.getPreferredSystemLanguages() : [app.getLocale()];
const tr = (key, vars) => i18n ? i18n.t(key, vars, currentLanguage?.() || i18n.resolveLanguage('system', locales())) : 'Agenda failed to start';

async function createWindow(url) {
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
  const isAppUrl = (target) => target === url || target.startsWith(url + '/');
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !isAppUrl(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!isAppUrl(target)) { e.preventDefault(); if (/^https?:\/\//i.test(target)) shell.openExternal(target); }
  });
  win.on('focus', () => win.flashFrame(false));
  // 设了定时任务：关窗口只是藏到托盘，定时任务照常运行；从托盘菜单或系统退出时才真的关
  win.on('close', (e) => {
    if (!keepInTray || quitting) return;
    e.preventDefault();
    win.hide();
    trayMenu();
    trayNotice();
  });
  win.on('show', () => { if (!keepInTray) setTray(false); });
  win.on('session-end', () => { quitting = true; }); // Windows 注销 / 关机：别拦着
  // F12 打开开发者工具，Ctrl+R 刷新
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') win.webContents.reload();
  });
  await win.webContents.session.cookies.set({ url, name: srv.cookieName, value: cookieToken, httpOnly: true, sameSite: 'strict', path: '/api' });
  await win.loadURL(url);
}

const showWindow = () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

app.on('second-instance', showWindow);

const notices = new Set();

// ---------- 托盘（设了定时任务时）----------
let tray = null;
let keepInTray = false;
let quitting = false;
function trayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: tr('打开 Agenda'), click: showWindow },
    { label: tr('退出'), click: () => { quitting = true; app.quit(); } },
  ]));
}
function setTray(on) {
  keepInTray = on;
  if (on && !tray) {
    // Windows 用 ico（系统自己挑合适的尺寸）；macOS 菜单栏和 Linux 托盘要小图
    const icon = nativeImage.createFromPath(ICON);
    tray = new Tray(process.platform === 'win32' ? icon : icon.resize({ width: process.platform === 'darwin' ? 18 : 24 }));
    tray.setToolTip('Agenda');
    tray.on('click', showWindow);
    trayMenu();
  } else if (!on && tray && win?.isVisible()) {
    // 窗口还藏着的时候（比如只跑一次的定时任务刚跑完）先留着托盘，不然就打不开窗口了；窗口出来后再去掉
    tray.destroy();
    tray = null;
  }
}
// 第一次缩到托盘时提示一次
function trayNotice() {
  if (readUi().trayNotice || !Notification.isSupported()) return;
  const n = new Notification({ title: tr('Agenda 还在后台运行'), body: tr('设了定时任务，关掉窗口后会照常运行。从托盘图标可以打开或退出。'), icon: ICON });
  notices.add(n);
  n.on('click', showWindow);
  n.on('close', () => notices.delete(n));
  n.show();
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(UI_FILE, JSON.stringify({ ...readUi(), trayNotice: true })); } catch { /* 记不住就下次再提示 */ }
}
let blocker = null;

app.whenReady().then(async () => {
  i18n = await import(pathToFileURL(path.join(ROOT, 'src', 'i18n.mjs')).href);
  // macOS 没有菜单时复制、粘贴等快捷键也会失效，只保留最基本的应用和编辑菜单
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
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
    auth: { token: apiToken, cookieToken },
    hooks: {
      desktop: true,
      locales,
      onLanguage: (getLanguage) => { currentLanguage = getLanguage; },
      openPath: (p) => shell.openPath(p),
      revealPath: (p) => shell.showItemInFolder(p),
      // 有命令等你确认：窗口不在前台时让任务栏图标闪烁，切回窗口就停
      attention: () => { if (win && !win.isFocused()) win.flashFrame(true); },
      // AI 做完或等你处理：窗口不在前台时弹系统通知，点通知打开那个空间
      notify: ({ spaceId, title, body }) => {
        if (!win || win.isFocused() || !Notification.isSupported()) return;
        win.flashFrame(true);
        const n = new Notification({ title, body, icon: ICON });
        notices.add(n); // 留着引用，不然被回收后点通知没反应
        n.on('click', () => {
          showWindow();
          win.webContents.send('open-space', spaceId);
        });
        n.on('close', () => notices.delete(n));
        n.show();
      },
      // 有 AI 在干活：不让系统睡眠（屏幕照常可以关）
      keepAwake: (on) => {
        if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
        else if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
      },
      // 有没有启用的定时任务：决定关窗口是缩到托盘还是退出
      scheduleActive: (on) => setTray(on),
      protect: (s) => (canEncrypt ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s }),
      unprotect: (o) => (o?.enc ? safeStorage.decryptString(Buffer.from(o.enc, 'base64')) : o?.plain || ''),
    },
  });

  ipcMain.on('get-api-token', (e) => {
    e.returnValue = win && e.sender === win.webContents ? apiToken : '';
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: tr('选择共享文件夹'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    srv.allowFolder(r.filePaths[0]);
    return r.filePaths[0];
  });

  ipcMain.handle('get-theme', () => nativeTheme.themeSource);
  ipcMain.handle('set-theme', (_e, t) => {
    if (!THEMES.includes(t) || nativeTheme.themeSource === t) return;
    nativeTheme.themeSource = t; // 页面里的 prefers-color-scheme 也跟着变
    win?.setBackgroundColor(windowBg());
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(UI_FILE, JSON.stringify({ ...readUi(), theme: t })); } catch { /* 记不住也不影响使用 */ }
  });

  console.log(tr('Agenda 桌面版已启动：{0}', [srv.url]));
  await createWindow(srv.url);
}).catch((e) => {
  dialog.showErrorBox(tr('Agenda 启动失败'), String(e?.stack || e));
  app.quit();
});

app.on('window-all-closed', () => {
  srv?.close();
  app.quit();
});
// 不是关窗口退出的（系统注销、任务栏“关闭窗口”之外的退出）也要结束 AI 进程；重复调用没关系
app.on('before-quit', () => { quitting = true; srv?.close(); });
