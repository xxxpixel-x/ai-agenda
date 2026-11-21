// 桌面版内部的本机 HTTP 服务：给窗口里的界面提供接口与实时事件（SSE）。只监听 127.0.0.1。
import { t as tr, resolveLanguage, withLanguage } from './i18n.mjs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Space, KINDS, folderKey, removeSpaceFiles } from './space.mjs';
import { createSettings } from './settings.mjs';
import { createRegistry, CLI_ENGINE_IDS } from './engines/index.mjs';
import { listSessions, configureImporters, stagePasted } from './importers/index.mjs';
import { createScheduler } from './scheduler.mjs';
import { summarize, latest } from './usage.mjs';
import { sessionDetail, forkedSessionIds, importSession, checkImport, refreshImport, recompressImport, resolveBrief, topicFolder } from './imports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function insideFolder(folder, target) {
  // relative 按平台比较路径段；Windows 下忽略大小写，跨盘会得到绝对路径。
  const rel = path.relative(folder, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * @param opts.port      0 表示随机端口
 * @param opts.dataDir   数据目录
 * @param opts.mock      演示模式
 * @param opts.hooks     { openPath(p), revealPath(p), protect(s), unprotect(o), attention(), scheduleActive(on), desktop: true }
 *                       attention：有命令等你确认（桌面版让任务栏图标闪烁）
 *                       scheduleActive：有没有启用的定时任务变了（桌面版据此决定关窗口是缩到托盘还是退出）
 * @param opts.clock     { now, setTimer, clearTimer }：测试用假时钟换掉定时任务的时钟
 */
export async function startServer({ port = 3210, dataDir, mock = false, hooks = {}, clock = {} } = {}) {
  fs.mkdirSync(path.join(dataDir, 'spaces'), { recursive: true });
  const settings = createSettings(path.join(dataDir, 'settings.json'), { pathKeys: CLI_ENGINE_IDS, protect: hooks.protect, unprotect: hooks.unprotect });
  let browserLocales = [];
  const locales = () => hooks.locales?.() || browserLocales;
  const language = () => resolveLanguage(settings.get().language, locales());
  hooks.onLanguage?.(language);
  const registry = createRegistry(settings, { mock });
  const store = new Store(path.join(dataDir, 'spaces'));
  const spaces = new Map();
  // 跨空间的事都经过这里：空间之间不直接互相引用
  const hooks2 = {
    /** 同一个文件夹有任务空间在“依次直接改”：聊天空间暂时只读。 */
    folderLock(space) {
      const k = folderKey(space.workspacePath);
      for (const s of spaces.values()) {
        if (s !== space && s.isTask && s.run?.locksFolder && folderKey(s.workspacePath) === k) return { spaceId: s.id, title: s.data.title };
      }
      return null;
    },
    acceptCopy(space, rel) {
      const abs = space.ws.resolve(rel);
      for (const other of spaces.values()) {
        if (other === space || !insideFolder(other.workspacePath, abs)) continue;
        const key = path.relative(other.workspacePath, abs).split(path.sep).join('/');
        other.ws.acceptCopy(key);
      }
    },
    folderInUse: (p, exceptId) => [...spaces.values()].some((s) => s.id !== exceptId && !s.deleting && folderKey(s.workspacePath) === folderKey(p)),
    spaceTitle: (id) => { const s = spaces.get(id); return s && !s.isTask ? s.data.title : null; },
    postToSpace: (id, msg) => !!spaces.get(id)?.receive(msg),
  };
  const deps = { registry, store, dataDir, hooks: hooks2 };
  configureImporters({ dataDir });

  // 侧栏要知道每个空间的状态（发言中、等你确认、任务等你），不只是当前打开的那个
  const hub = new EventEmitter();
  hub.setMaxListeners(100);
  let hubTimer = null;
  const LIST_EVENTS = new Set(['state', 'approval', 'run', 'message_done', 'snapshot']);
  // 任务空间开始 / 停止“依次直接改”时，告诉用同一个文件夹的聊天空间（文件面板的锁、发言权限）
  const locks = new Map();
  const refreshLocks = () => {
    for (const s of spaces.values()) {
      if (s.isTask) continue;
      const lock = s.readOnly;
      const key = lock ? lock.spaceId : '';
      if ((locks.get(s.id) || '') === key) continue;
      locks.set(s.id, key);
      s.emitEvent({ type: 'lock', readOnly: lock });
    }
  };
  // 有 AI 在干活时不让电脑睡眠（桌面版，设置里可关）
  let awake = false;
  const refreshAwake = () => {
    const on = settings.get().keepAwake && [...spaces.values()].some((s) => s.listItem().running);
    if (on !== awake) { awake = on; hooks.keepAwake?.(on); }
  };
  // AI 做完或等你处理时提醒（桌面版弹系统通知，设置里可关）
  const notify = (space, body) => {
    if (settings.get().notify) hooks.notify?.({ spaceId: space.id, title: space.data.title || 'Agenda', body });
  };
  // 任务空间里需要提醒的状态：协调者先问你、计划待确认、子任务等验收 / 在问你 / 出错、任务做完。只提醒新出现的
  const taskAlerts = (space) => {
    const r = space.run?.data;
    const out = new Map();
    if (!r || r.closed) return out;
    if (r.status === 'clarifying') out.set('clarify', tr('协调者有几个问题想先问你'));
    if (r.status === 'plan_review' && r.planConfirm !== 'auto') out.set('plan', tr('任务计划等你确认'));
    if (r.status === 'done') out.set('done', tr('任务做完了，总结已写好'));
    if (r.status === 'failed') out.set('failed', tr('任务出错停下了'));
    const say = { blocked: '子任务「{0}」在问你', failed: '子任务「{0}」出错了', ...(r.autoApprove ? {} : { review: '子任务「{0}」等你验收' }) };
    for (const t of r.tasks) if (say[t.status] && !t.removed) out.set(`${t.id}:${t.status}`, tr(say[t.status], [t.title]));
    return out;
  };
  const seenAlerts = new Map(); // spaceId -> 上次的提醒状态
  const addSpace = (space) => {
    spaces.set(space.id, space);
    if (space.isTask) seenAlerts.set(space.id, new Set(taskAlerts(space).keys()));
    space.on('event', (ev) => {
      if (ev.type === 'approval' && ev.approval.status === 'pending') {
        hooks.attention?.();
        const who = space.data.messages.find((m) => m.id === ev.id)?.name;
        notify(space, tr('{0} 想运行命令，等你确认', [who || 'AI']));
      }
      if (ev.type === 'round_end' && !space.isTask && !ev.stopped) {
        notify(space, ev.failed ? tr('{0} 出错了，讨论已停下', [ev.failed]) : tr('讨论告一段落，轮到你了'));
      }
      if (space.isTask && ev.type === 'run') {
        const now = taskAlerts(space);
        const seen = seenAlerts.get(space.id) || new Set();
        const fresh = [...now].find(([k]) => !seen.has(k));
        seenAlerts.set(space.id, new Set(now.keys()));
        if (fresh) notify(space, fresh[1]);
      }
      if (space.isTask && (ev.type === 'run' || ev.type === 'snapshot')) refreshLocks();
      if (!LIST_EVENTS.has(ev.type)) return;
      clearTimeout(hubTimer);
      hubTimer = setTimeout(() => { hub.emit('spaces'); refreshAwake(); }, 300);
    });
    return space;
  };
  // 升级：以前的空间里既有聊天也有任务协作，不再兼容，全部删掉（软件建的共享文件夹一起删，你自己选的文件夹不动）
  let removedLegacy = 0;
  const legacy = [];
  for (const data of store.loadAll()) {
    if (!KINDS.includes(data.kind)) { legacy.push(data); continue; }
    try { addSpace(new Space(data, deps)); } catch (e) { console.warn(tr('跳过无法打开的空间：'), e.message); }
  }
  for (const data of legacy) {
    try {
      await removeSpaceFiles(data, path.join(dataDir, 'spaces', data.id));
      store.remove(data.id);
      removedLegacy++;
    } catch (e) { console.warn(tr('删除旧空间失败：{0}', [e.message])); }
  }
  // 建好但还没开始规划就关了软件的任务空间：接着开始
  for (const s of spaces.values()) if (s.isTask && !s.run && s.data.pendingTask) s.startTask().catch((e) => console.warn(e.message));

  // ---------- 定时任务 ----------
  // 调度器不认识空间：到点要做的事都在这里接到空间上
  const scheduledSpaces = (id) => [...spaces.values()].filter((s) => s.data.scheduleId === id && !s.deleting);
  // 新建任务空间（POST /api/spaces 和定时任务共用）：建好直接进入规划；开不了（比如文件夹出问题）就不留下这个空间
  const createTaskSpace = async (input) => {
    const space = addSpace(Space.create({ ...input, kind: 'task' }, deps));
    try { await space.startTask(); } catch (e) {
      await space.remove().catch(() => {});
      spaces.delete(space.id);
      seenAlerts.delete(space.id);
      throw e;
    }
    return space;
  };
  const scheduleActions = {
    // 模板：{ title, goal, members, coordinatorId, workspace, access, planConfirm, reviewPlan, autoApprove, maxParallel }
    async createTaskSpace(tpl, schedule) {
      const space = await createTaskSpace({
        title: tpl.title, objective: tpl.goal, members: tpl.members, coordinatorId: tpl.coordinatorId,
        workspace: tpl.workspace, access: tpl.access, planConfirm: tpl.planConfirm, discuss: tpl.reviewPlan,
        autoApprove: tpl.autoApprove, maxParallel: tpl.maxParallel,
        scheduleId: schedule.id, clarify: false, // 定时建的任务不做规划前澄清
      });
      hub.emit('spaces');
      return space.id;
    },
    // 像你在输入框里发的一样，成员照常发言
    postMessage(spaceId, text) {
      const space = spaces.get(spaceId);
      if (!space || space.deleting) throw new Error(tr('这个空间不存在'));
      if (space.isTask) throw new Error(tr('定时消息只能发到聊天空间'));
      return space.userMessage(text);
    },
    // 上一次还没跑完：建的任务空间还在规划或执行（写完总结、失败、结束都算跑完），或者聊天空间这一轮还没说完
    isBusy(schedule) {
      if (schedule.action.type === 'task') {
        return scheduledSpaces(schedule.id).some((s) => !!s.data.pendingTask || (!!s.run && !s.run.data.closed && s.run.active));
      }
      const target = spaces.get(schedule.spaceId);
      return !!target && (target.running || !!target.importing);
    },
  };
  let scheduleOn = null;
  let scheduler = null;
  scheduler = createScheduler({
    file: path.join(dataDir, 'schedules.json'),
    ...clock,
    actions: scheduleActions,
    onChange() {
      if (!scheduler) return;
      const on = scheduler.hasActive();
      if (on !== scheduleOn) { scheduleOn = on; hooks.scheduleActive?.(on); }
      hub.emit('schedules');
    },
  });
  // 所属空间被删了：停用，运行记录里记一笔（不删，全局设置里还看得到）
  const disableSchedulesOf = (spaceId) => {
    for (const s of scheduler.list()) if (s.spaceId === spaceId && s.enabled) scheduler.disable(s.id, 'space_deleted');
  };
  for (const s of scheduler.list()) if (s.enabled && !spaces.has(s.spaceId)) scheduler.disable(s.id, 'space_deleted');
  if (scheduleOn === null) { scheduleOn = scheduler.hasActive(); hooks.scheduleActive?.(scheduleOn); }
  scheduler.start();
  // 新建 / 修改定时任务：检查所属空间和动作对得上
  const checkSchedule = (def) => {
    const space = spaces.get(def.spaceId);
    if (!space || space.deleting) throw new Error(tr('这个空间不存在'));
    if (def.action?.type === 'message' && space.isTask) throw new Error(tr('定时消息只能发到聊天空间'));
    if (def.action?.type === 'task') {
      const tpl = def.action.template || {};
      if (typeof tpl.goal !== 'string' || !tpl.goal.trim()) throw new Error(tr('请写下这次要完成的目标'));
      if (!Array.isArray(tpl.members) || !tpl.members.length) throw new Error(tr('任务模板里没有成员'));
    }
  };

  let actualPort = port;

  // ---------- 工具 ----------
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req, max = 10_000_000) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      if (size > max) return;
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        reject(Object.assign(new Error(tr('请求体太大')), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error(tr('JSON 格式错误')), { status: 400 })); }
    });
    req.on('error', reject);
  });
  // 只接受本机访问：防 DNS rebinding 与其他网站的跨站请求（它们会花你的 AI 额度、改你的文件）
  const allowedHost = (req) => {
    const h = (req.headers.host || '').toLowerCase();
    return h === `localhost:${actualPort}` || h === `127.0.0.1:${actualPort}`;
  };
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host.toLowerCase() === (req.headers.host || '').toLowerCase(); } catch { return false; }
  };

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: tr('禁止访问') });
    fs.readFile(file, (err, buf) => {
      if (err) return sendJson(res, 404, { error: tr('未找到') });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  function openSse(req, res, space) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write('retry: 2000\n\n');
    send({ type: 'snapshot', space: space.toJSON() });
    space.on('event', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { space.off('event', send); clearInterval(ping); });
  }

  function openHubSse(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const send = () => res.write(`data: ${JSON.stringify({ type: 'spaces' })}\n\n`);
    const sendSchedules = () => res.write(`data: ${JSON.stringify({ type: 'schedules' })}\n\n`);
    hub.on('spaces', send);
    hub.on('schedules', sendSchedules);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { hub.off('spaces', send); hub.off('schedules', sendSchedules); clearInterval(ping); });
  }

  const getSpace = (id) => {
    const s = spaces.get(id);
    if (!s) throw Object.assign(new Error(tr('这个空间不存在')), { status: 404 });
    return s;
  };

  // ---------- 路由 ----------
  async function handle(req, res) {
    if (!allowedHost(req)) return sendJson(res, 403, { error: tr('只允许从本机访问') });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    if (!p.startsWith('/api/')) {
      if (method !== 'GET') return sendJson(res, 405, { error: tr('不支持此请求方法') });
      return serveStatic(res, p);
    }
    if (method !== 'GET') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: tr('拒绝跨站请求') });
      if (!(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: tr('需要 application/json') });
    }

    if (p === '/api/app' && method === 'GET') {
      browserLocales = String(req.headers['x-agenda-languages'] || req.headers['accept-language'] || '')
        .split(',').map((s) => s.split(';')[0].trim()).filter(Boolean);
      return sendJson(res, 200, { mock, desktop: !!hooks.desktop, platform: process.platform, dataDir, language: settings.get().language, locales: locales(), resolvedLanguage: language(), removedLegacy });
    }
    if (p === '/api/engines' && method === 'GET') {
      return sendJson(res, 200, await registry.detectAll({ refresh: url.searchParams.get('refresh') === '1' }));
    }
    if (p === '/api/settings' && method === 'GET') return sendJson(res, 200, settings.publicView());
    if (p === '/api/settings' && method === 'PUT') {
      const view = settings.update(await readJson(req));
      registry.invalidate();
      refreshAwake();
      return sendJson(res, 200, view);
    }
    if ((p === '/api/open-path' || p === '/api/reveal-path') && method === 'POST') {
      const { path: target } = await readJson(req);
      const action = p === '/api/open-path' ? hooks.openPath : hooks.revealPath;
      if (!action) return sendJson(res, 400, { error: tr('当前环境不能打开文件夹') });
      const file = typeof target === 'string' && target && path.resolve(target);
      const roots = [...spaces.values()].map((s) => s.workspacePath).filter((root) => file && insideFolder(root, file));
      if (!roots.length) return sendJson(res, 403, { error: tr('只能打开空间的共享文件夹') });
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: tr('文件或文件夹不存在') });
      // 再检查实际位置，避免通过符号链接或目录联接跳出共享文件夹。
      const real = fs.realpathSync.native(file);
      if (!roots.some((root) => insideFolder(fs.realpathSync.native(root), real))) return sendJson(res, 403, { error: tr('只能打开空间的共享文件夹') });
      const error = await action(file);
      if (typeof error === 'string' && error) throw new Error(error);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/events' && method === 'GET') return openHubSse(req, res);
    if (p === '/api/spaces' && method === 'GET') {
      return sendJson(res, 200, [...spaces.values()].map((s) => s.listItem()).sort((a, b) => b.updatedAt - a.updatedAt));
    }
    // ---- 定时任务 ----
    if (p === '/api/schedules' && method === 'GET') {
      const spaceId = url.searchParams.get('spaceId');
      return sendJson(res, 200, scheduler.list().filter((s) => !spaceId || s.spaceId === spaceId));
    }
    if (p === '/api/schedules' && method === 'POST') {
      const def = await readJson(req);
      checkSchedule(def);
      return sendJson(res, 201, scheduler.add(def));
    }
    if (p === '/api/schedules/runs' && method === 'GET') return sendJson(res, 200, scheduler.runs());
    const sm = p.match(/^\/api\/schedules\/([a-f0-9-]{36})(\/runs)?$/i);
    if (sm) {
      const current = scheduler.list().find((s) => s.id === sm[1]);
      if (!current) return sendJson(res, 404, { error: tr('没有这个定时任务') });
      if (sm[2] && method === 'GET') return sendJson(res, 200, scheduler.runs(current.id));
      if (!sm[2] && method === 'GET') return sendJson(res, 200, current);
      if (!sm[2] && method === 'PATCH') {
        const patch = await readJson(req);
        checkSchedule({ ...current, ...patch, spaceId: current.spaceId });
        return sendJson(res, 200, scheduler.update(current.id, patch));
      }
      if (!sm[2] && method === 'DELETE') { scheduler.remove(current.id); return sendJson(res, 200, { ok: true }); }
    }
    // ---- 导入外部 AI 对话 ----
    if (p === '/api/import/sessions' && method === 'GET') {
      return sendJson(res, 200, listSessions({ exclude: { ids: forkedSessionIds([...spaces.values()].map((s) => s.importHost)), dir: dataDir } }));
    }
    if (p === '/api/import/paste' && method === 'POST') {
      // { text } 粘贴的文字；或 { data, name } 选择的文件（base64，可以是导出的 zip）
      const b = await readJson(req, 300_000_000);
      return sendJson(res, 200, stagePasted(b.data ? Buffer.from(String(b.data), 'base64') : String(b.text || ''), String(b.name || '')));
    }
    if (p === '/api/import/session' && method === 'GET') {
      return sendJson(res, 200, sessionDetail(url.searchParams.get('source'), url.searchParams.get('id')));
    }

    if (p === '/api/spaces' && method === 'POST') {
      const body = await readJson(req);
      if (body.import?.mode === 'topic' && body.workspace?.type === 'folder') topicFolder(body.workspace.path, body.import);
      const space = body.kind === 'task' ? await createTaskSpace(body) : addSpace(Space.create(body, deps));
      let importError;
      if (body.import) {
        // 新建空间时从一段对话开始：对应的成员已在成员列表里，取第一个同类成员
        try { importSession(space.importHost, { ...body.import, memberId: undefined }); } catch (e) { importError = e.message; }
      }
      return sendJson(res, 201, { ...space.toJSON(), importError });
    }

    const m = p.match(/^\/api\/spaces\/([a-f0-9-]{36})(\/[a-z]+)?(?:\/([a-z0-9_-]+))?(\/[a-z]+)?$/i);
    if (m) {
      const space = getSpace(m[1]);
      const sub = m[2] || '';
      const arg = m[3];
      const tail = m[4] || '';
      if (space.deleting && method !== 'GET' && method !== 'DELETE') return sendJson(res, 409, { error: tr('这个空间正在删除，请稍等') });

      if (sub === '' && method === 'GET') return sendJson(res, 200, space.toJSON());
      if (sub === '' && method === 'PATCH') { space.update(await readJson(req)); return sendJson(res, 200, space.toJSON()); }
      if (sub === '' && method === 'DELETE') {
        await space.remove();
        spaces.delete(space.id);
        seenAlerts.delete(space.id);
        disableSchedulesOf(space.id);
        refreshAwake();
        return sendJson(res, 200, { ok: true });
      }
      // ---- 任务 ----
      if (sub === '/taskcheck' && method === 'GET') return sendJson(res, 200, await space.taskPreflight());
      if (sub === '/run' && method === 'POST' && arg) return sendJson(res, 200, await space.runAction(arg, await readJson(req)));
      if (sub === '/task' && method === 'GET' && arg) {
        if (!space.run) throw Object.assign(new Error(tr('没有进行中的任务')), { status: 404 });
        return sendJson(res, 200, space.run.taskDetail(arg));
      }
      if (sub === '/taskdiff' && method === 'GET' && arg) {
        if (!space.run) throw Object.assign(new Error(tr('没有进行中的任务')), { status: 404 });
        return sendJson(res, 200, await space.run.fileDiff(arg, url.searchParams.get('path')));
      }
      if (sub === '/events' && method === 'GET') return openSse(req, res, space);
      // 成员用量：最近一次（上下文、额度）、这个空间合计、今天（本地日期）合计
      if (sub === '/usage' && method === 'GET' && !arg) {
        const d = new Date();
        const today = summarize(space.data, { since: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() });
        const members = {};
        for (const [id, total] of Object.entries(summarize(space.data))) {
          members[id] = { latest: latest(space.data, id), total, today: today[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 } };
        }
        return sendJson(res, 200, { members });
      }
      if (sub === '/context' && method === 'GET' && !arg) return sendJson(res, 200, space.contextView());
      try {
        if (sub === '/recap' && method === 'PUT' && !arg) {
          const { text, version } = await readJson(req);
          return sendJson(res, 200, { recap: space.updateRecap(text, version) });
        }
        if (sub === '/members' && method === 'POST' && tail === '/handoff') {
          return sendJson(res, 200, { ok: true, handoff: await space.handoffMember(arg) });
        }
      } catch (e) {
        return sendJson(res, e.status || 400, { error: e.message, ...(e.recap ? { recap: e.recap } : {}) });
      }
      if (sub === '/memory' && method === 'GET' && !arg) return sendJson(res, 200, space.memoryView()); // 记忆库（只读）
      if (sub === '/imports' && method === 'POST' && !arg) return sendJson(res, 201, importSession(space.importHost, await readJson(req)));
      if (sub === '/imports' && method === 'GET' && arg && tail === '/check') return sendJson(res, 200, checkImport(space.importHost, arg));
      if (sub === '/imports' && method === 'POST' && arg && tail === '/refresh') return sendJson(res, 200, refreshImport(space.importHost, arg));
      if (sub === '/imports' && method === 'POST' && arg && tail === '/brief') return sendJson(res, 200, resolveBrief(space.importHost, arg, (await readJson(req)).action));
      if (sub === '/imports' && method === 'POST' && arg && tail === '/recompress') return sendJson(res, 200, recompressImport(space.importHost, arg, (await readJson(req)).mode));
      if (sub === '/approvals' && method === 'POST' && arg) {
        const { decision, note } = await readJson(req);
        return sendJson(res, 200, space.decideApproval(arg, decision, note));
      }
      if (sub === '/members' && method === 'PATCH' && arg) return sendJson(res, 200, space.updateMember(arg, await readJson(req)));
      if (sub === '/attachments' && !tail) {
        if (method === 'POST' && !arg) {
          const body = await readJson(req, 80 * 1024 * 1024);
          return sendJson(res, 201, space.attachments.stage(body));
        }
        if (method === 'DELETE' && arg) {
          space.attachments.remove(space.staged(arg));
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'GET' && arg) {
          const a = space.attachments.get(arg);
          if (a.kind !== 'image') return sendJson(res, 404, { error: tr('未找到') });
          const bytes = fs.readFileSync(space.attachments.pathOf(a));
          res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'private, max-age=31536000', 'X-Content-Type-Options': 'nosniff' });
          return res.end(bytes);
        }
      }
      if (sub === '/messages' && method === 'POST') {
        const { text, attachments, only } = await readJson(req);
        return sendJson(res, 201, await space.userMessage(text, attachments, { only }));
      }
      // 聊天空间 → 任务空间：让一个成员把选出的讨论提炼成任务目标
      if (sub === '/distill' && method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, await space.distill(b.ids, b.memberId));
      }
      if (sub === '/control' && method === 'POST') {
        const { action, memberId } = await readJson(req);
        const actions = {
          stop: () => space.stop(),
          skip: () => space.skip(),
          continue: () => space.continueDiscussion(),
          ask: () => space.ask(memberId),
        };
        if (!actions[action]) return sendJson(res, 400, { error: tr('未知操作：{0}', [action]) });
        actions[action]();
        return sendJson(res, 200, { ok: true });
      }
      if (sub === '/files' && method === 'GET') {
        return sendJson(res, 200, { root: space.workspacePath, truncated: space.ws.truncated, files: space.ws.list() });
      }
      if (sub === '/file' && method === 'GET') {
        return sendJson(res, 200, { path: url.searchParams.get('path'), content: space.ws.read(url.searchParams.get('path')) });
      }
      if (sub === '/file' && method === 'PUT') {
        const body = await readJson(req);
        return sendJson(res, 200, { changes: space.writeFile(body.path, body.content) });
      }
      if (sub === '/history' && method === 'GET' && !arg) return sendJson(res, 200, space.ws.historyList());
      if (sub === '/history' && method === 'GET' && arg && !tail) return sendJson(res, 200, space.ws.change(arg));
      if (sub === '/history' && method === 'POST' && arg && tail === '/undo') {
        const body = await readJson(req);
        return sendJson(res, 200, { changes: space.undo(arg, { force: !!body.force }) });
      }
      if (sub === '/export' && method === 'GET') {
        const name = encodeURIComponent(`${space.data.title}.md`);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` });
        return res.end(space.toMarkdown());
      }
    }
    return sendJson(res, 404, { error: tr('未找到') });
  }

  const server = http.createServer((req, res) => {
    withLanguage(language, () => handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, e.status || 400, { error: e.message, conflict: !!e.conflict });
      else res.end();
    }));
  });

  await new Promise((resolve, reject) => {
    const tryListen = (p) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && port !== 0 && p < port + 20) tryListen(p + 1);
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => resolve());
    };
    tryListen(port);
  });
  actualPort = server.address().port;

  return {
    url: `http://localhost:${actualPort}`,
    port: actualPort,
    registry,
    language,
    stopAll() { for (const s of spaces.values()) s.stop(); },
    // 退出时结束所有 AI 进程（包括任务协作里的），不留在后台继续花额度、改文件
    close() {
      scheduler.stop();
      for (const s of spaces.values()) s.shutdown();
      if (server.listening) server.close();
    },
  };
}
