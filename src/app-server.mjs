// 桌面版内部的本机 HTTP 服务：给窗口里的界面提供接口与实时事件（SSE）。只监听 127.0.0.1。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Space } from './space.mjs';
import { createSettings } from './settings.mjs';
import { createRegistry, CLI_ENGINE_IDS } from './engines/index.mjs';
import { listSessions } from './importers/index.mjs';
import { sessionDetail, forkedSessionIds, importSession, checkImport, refreshImport, recompressImport } from './imports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

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
 * @param opts.hooks     { openPath(p), protect(s), unprotect(o), desktop: true }
 */
export async function startServer({ port = 3210, dataDir, mock = false, hooks = {} } = {}) {
  fs.mkdirSync(path.join(dataDir, 'spaces'), { recursive: true });
  const settings = createSettings(path.join(dataDir, 'settings.json'), { pathKeys: CLI_ENGINE_IDS, protect: hooks.protect, unprotect: hooks.unprotect });
  const registry = createRegistry(settings, { mock });
  const store = new Store(path.join(dataDir, 'spaces'));
  const deps = { registry, store, dataDir };

  const spaces = new Map();
  for (const data of store.loadAll()) {
    try { spaces.set(data.id, new Space(data, deps)); } catch (e) { console.warn('跳过无法打开的空间：', e.message); }
  }

  let actualPort = port;

  // ---------- 工具 ----------
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000_000) { reject(Object.assign(new Error('请求体太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
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
    if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
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

  const getSpace = (id) => {
    const s = spaces.get(id);
    if (!s) throw Object.assign(new Error('这个空间不存在'), { status: 404 });
    return s;
  };

  // ---------- 路由 ----------
  async function handle(req, res) {
    if (!allowedHost(req)) return sendJson(res, 403, { error: '只允许从本机访问' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    if (!p.startsWith('/api/')) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return serveStatic(res, p);
    }
    if (method !== 'GET') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '拒绝跨站请求' });
      if (!(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: '需要 application/json' });
    }

    if (p === '/api/app' && method === 'GET') {
      return sendJson(res, 200, { mock, desktop: !!hooks.desktop, dataDir });
    }
    if (p === '/api/engines' && method === 'GET') {
      return sendJson(res, 200, await registry.detectAll({ refresh: url.searchParams.get('refresh') === '1' }));
    }
    if (p === '/api/settings' && method === 'GET') return sendJson(res, 200, settings.publicView());
    if (p === '/api/settings' && method === 'PUT') {
      const view = settings.update(await readJson(req));
      registry.invalidate();
      return sendJson(res, 200, view);
    }
    if (p === '/api/open-path' && method === 'POST') {
      const { path: target } = await readJson(req);
      if (!hooks.openPath) return sendJson(res, 400, { error: '当前环境不能打开文件夹' });
      const known = [...spaces.values()].some((s) => path.resolve(target || '') === s.workspacePath);
      if (!known) return sendJson(res, 403, { error: '只能打开空间的共享文件夹' });
      await hooks.openPath(target);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/spaces' && method === 'GET') {
      return sendJson(res, 200, [...spaces.values()].map((s) => s.listItem()).sort((a, b) => b.updatedAt - a.updatedAt));
    }
    // ---- 导入外部 AI 对话 ----
    if (p === '/api/import/sessions' && method === 'GET') {
      return sendJson(res, 200, listSessions({ exclude: { ids: forkedSessionIds(spaces.values()), dir: dataDir } }));
    }
    if (p === '/api/import/session' && method === 'GET') {
      return sendJson(res, 200, sessionDetail(url.searchParams.get('source'), url.searchParams.get('id')));
    }

    if (p === '/api/spaces' && method === 'POST') {
      const body = await readJson(req);
      const space = Space.create(body, deps);
      spaces.set(space.id, space);
      let importError;
      if (body.import) {
        // 新建空间时从一段对话开始：对应的成员已在成员列表里，取第一个同类成员
        try { importSession(space, { ...body.import, memberId: undefined }); } catch (e) { importError = e.message; }
      }
      return sendJson(res, 201, { ...space.toJSON(), importError });
    }

    const m = p.match(/^\/api\/spaces\/([a-f0-9-]{36})(\/[a-z]+)?(?:\/([a-z0-9-]+))?(\/[a-z]+)?$/i);
    if (m) {
      const space = getSpace(m[1]);
      const sub = m[2] || '';
      const arg = m[3];
      const tail = m[4] || '';

      if (sub === '' && method === 'GET') return sendJson(res, 200, space.toJSON());
      if (sub === '' && method === 'PATCH') { space.update(await readJson(req)); return sendJson(res, 200, space.toJSON()); }
      if (sub === '' && method === 'DELETE') { await space.remove(); spaces.delete(space.id); return sendJson(res, 200, { ok: true }); }
      // ---- 任务协作 ----
      if (sub === '/taskcheck' && method === 'GET') return sendJson(res, 200, await space.taskPreflight());
      if (sub === '/runs' && method === 'POST') return sendJson(res, 201, await space.startRun(await readJson(req)));
      if (sub === '/run' && method === 'POST' && arg) return sendJson(res, 200, await space.runAction(arg, await readJson(req)));
      if (sub === '/task' && method === 'GET' && arg) {
        if (!space.run) throw Object.assign(new Error('没有进行中的任务'), { status: 404 });
        return sendJson(res, 200, space.run.taskDetail(arg));
      }
      if (sub === '/taskdiff' && method === 'GET' && arg) {
        if (!space.run) throw Object.assign(new Error('没有进行中的任务'), { status: 404 });
        return sendJson(res, 200, await space.run.fileDiff(arg, url.searchParams.get('path')));
      }
      if (sub === '/events' && method === 'GET') return openSse(req, res, space);
      if (sub === '/imports' && method === 'POST' && !arg) return sendJson(res, 201, importSession(space, await readJson(req)));
      if (sub === '/imports' && method === 'GET' && arg && tail === '/check') return sendJson(res, 200, checkImport(space, arg));
      if (sub === '/imports' && method === 'POST' && arg && tail === '/refresh') return sendJson(res, 200, refreshImport(space, arg));
      if (sub === '/imports' && method === 'POST' && arg && tail === '/recompress') return sendJson(res, 200, recompressImport(space, arg, (await readJson(req)).mode));
      if (sub === '/messages' && method === 'POST') return sendJson(res, 201, space.userMessage((await readJson(req)).text));
      if (sub === '/control' && method === 'POST') {
        const { action, memberId } = await readJson(req);
        const actions = {
          stop: () => space.stop(),
          skip: () => space.skip(),
          continue: () => space.continueDiscussion(),
          ask: () => space.ask(memberId),
        };
        if (!actions[action]) return sendJson(res, 400, { error: `未知操作：${action}` });
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
    return sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, e.status || 400, { error: e.message, conflict: !!e.conflict });
      else res.end();
    });
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
    stopAll() { for (const s of spaces.values()) s.stop(); },
    close() { for (const s of spaces.values()) s.stop(); server.close(); },
  };
}
