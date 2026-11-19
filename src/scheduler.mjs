import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t as tr } from './i18n.mjs';

const MINUTE = 60_000;
const GRACE = 2 * MINUTE;
const RUN_LIMIT = 200;

export function nextTime(rule, after) {
  switch (rule.type) {
    case 'once':
      return rule.at > after ? rule.at : null;
    case 'interval': {
      if (after < rule.start) return rule.start;
      const step = rule.minutes * MINUTE;
      return rule.start + (Math.floor((after - rule.start) / step) + 1) * step;
    }
    case 'weekly': {
      const day = new Date(after);
      const [hh, mm] = rule.time.split(':').map(Number);
      for (let k = 0; k < 8; k++) {
        const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() + k, hh, mm);
        if (date.getTime() > after && rule.days.includes(date.getDay())) return date.getTime();
      }
    }
  }
  return null;
}

function checkedRule(rule, at) {
  switch (rule?.type) {
    case 'once':
      if (!Number.isFinite(rule.at)) throw new Error(tr('定时任务的时间无效'));
      return { type: 'once', at: rule.at };
    case 'weekly': {
      if (!Array.isArray(rule.days) || !rule.days.length) throw new Error(tr('请选择有效的星期几'));
      const days = [...new Set(rule.days)];
      if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error(tr('请选择有效的星期几'));
      if (typeof rule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) {
        throw new Error(tr('每周运行时间应为 HH:MM'));
      }
      return { type: 'weekly', days: days.sort((a, b) => a - b), time: rule.time };
    }
    case 'interval': {
      const { minutes, start = at } = rule;
      if (typeof minutes === 'number' && minutes < 5) throw new Error(tr('最短每隔 5 分钟'));
      if (!Number.isInteger(minutes) || minutes > 44640) throw new Error(tr('间隔必须是 5 到 44640 之间的整数分钟'));
      if (!Number.isFinite(start)) throw new Error(tr('定时任务的时间无效'));
      return { type: 'interval', minutes, start };
    }
    default:
      throw new Error(tr('不认识的时间规则'));
  }
}

function checkedAction(action) {
  if (action?.type === 'message') {
    const text = typeof action.text === 'string' && action.text.trim();
    if (!text || [...text].length > 8000) throw new Error(tr('定时消息需要 1 到 8000 字'));
    return { type: 'message', text };
  }
  if (action?.type === 'task') {
    const { template } = action;
    if (!template || ![Object.prototype, null].includes(Object.getPrototypeOf(template))) {
      throw new Error(tr('任务模板必须是普通对象'));
    }
    return { type: 'task', template: structuredClone(template) };
  }
  throw new Error(tr('不认识的定时动作'));
}

function checkedFields({ spaceId, title = '', enabled = true, rule, action }, at) {
  if (typeof spaceId !== 'string' || !spaceId.trim()) throw new Error(tr('定时任务需要所属空间'));
  if (typeof title !== 'string' || [...title.trim()].length > 60) throw new Error(tr('定时任务标题最多 60 字'));
  if (typeof enabled !== 'boolean') throw new Error(tr('启用状态必须是真或假'));
  return { spaceId, title: title.trim(), enabled, rule: checkedRule(rule, at), action: checkedAction(action) };
}

function reschedule(schedule, at) {
  if (schedule.rule.type === 'once' && schedule.rule.at <= at) throw new Error(tr('这个时间已经过了'));
  schedule.nextAt = schedule.enabled ? nextTime(schedule.rule, at) : null;
}

// 读坏的单条定时任务跳过；整个文件读不了时先另存一份 .bad，免得下次保存把它覆盖掉
function readState(file, now) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.schedules)) throw new Error(tr('定时任务文件格式无效'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(tr('读取定时任务失败：{0}', [error.message]));
      try { fs.copyFileSync(file, file + '.bad'); } catch { /* 备份不了也照常启动 */ }
    }
    return { version: 1, schedules: [], runs: {} };
  }
  const schedules = [];
  for (const schedule of data.schedules) {
    try {
      Object.assign(schedule, checkedFields(schedule, schedule.createdAt));
      if (typeof schedule.id !== 'string') throw new Error(tr('定时任务文件格式无效'));
      if (schedule.enabled && !Number.isFinite(schedule.nextAt)) schedule.nextAt = nextTime(schedule.rule, now());
      if (schedule.nextAt === null) schedule.enabled = false;
      schedules.push(schedule);
    } catch (error) {
      console.warn(tr('读取定时任务失败：{0}', [error.message]));
    }
  }
  const runs = {};
  const ids = new Set(schedules.map((s) => s.id));
  if (data.runs && typeof data.runs === 'object' && !Array.isArray(data.runs)) {
    for (const [id, records] of Object.entries(data.runs)) {
      if (ids.has(id) && Array.isArray(records)) runs[id] = records.filter((r) => Number.isFinite(r?.ts)).slice(-RUN_LIMIT);
    }
  }
  return { version: 1, schedules, runs };
}

// Keep the penultimate point too: if the last point runs, the missed range ends there.
function dueRange(rule, first, at) {
  if (rule.type === 'interval') {
    const step = rule.minutes * MINUTE;
    const count = Math.floor((at - first) / step) + 1;
    const last = first + (count - 1) * step;
    return { count, last, previous: last - step };
  }
  let count = 1, last = first, previous = null;
  for (let next = nextTime(rule, last); next !== null && next <= at; next = nextTime(rule, last)) {
    previous = last;
    last = next;
    count++;
  }
  return { count, last, previous };
}

export function createScheduler({ file, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, actions, onChange }) {
  const state = readState(file, now);
  const { schedules } = state;
  const running = new Set();
  // Persist the insertion order across schedules, even when several runs share a timestamp.
  let sequence = 0;
  for (const records of Object.values(state.runs)) {
    for (const record of records) sequence = Math.max(sequence, record.sequence ?? 0);
  }
  let started = false, checking = false, generation = 0, timer = null;

  function changed() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      console.error(tr('保存定时任务失败：{0}', [error.message]));
    }
    onChange?.();
  }

  function copy(schedule) {
    return { ...structuredClone(schedule), running: running.has(schedule.id) };
  }

  function find(id) {
    const schedule = schedules.find(s => s.id === id);
    if (!schedule) throw new Error(tr('没有这个定时任务'));
    return schedule;
  }

  function record(scheduleId, at, result) {
    const records = state.runs[scheduleId] ??= [];
    records.push({ id: randomUUID(), scheduleId, at, ts: now(), sequence: ++sequence, ...result });
    if (records.length > RUN_LIMIT) records.shift();
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function arm() {
    cancelTimer();
    if (!started || checking) return;
    const at = now();
    let delay = MINUTE;
    for (const s of schedules) {
      if (s.enabled) delay = Math.min(delay, s.nextAt - at);
    }
    timer = setTimer(check, Math.max(0, delay));
    timer?.unref?.();
  }

  async function perform(schedule, at) {
    const { id, action } = schedule;
    running.add(id);
    let result;
    try {
      let spaceId = schedule.spaceId;
      if (action.type === 'task') spaceId = await actions.createTaskSpace(action.template, schedule);
      else await actions.postMessage(spaceId, action.text, schedule);
      result = { status: 'ok', spaceId };
    } catch (error) {
      result = { status: 'failed', error: error?.message ?? String(error) };
    } finally {
      running.delete(id);
    }
    if (schedules.some(s => s.id === id)) {
      record(id, at, result);
      changed();
    }
  }

  async function check() {
    timer = null;
    if (!started || checking) return;
    checking = true;
    const turn = generation;
    try {
      const at = now();
      for (const schedule of [...schedules]) {
        if (turn !== generation) break;
        const first = schedule.nextAt;
        if (!schedules.includes(schedule) || !schedule.enabled || first > at) continue;
        const { count, last, previous } = dueRange(schedule.rule, first, at);
        const due = at - last <= GRACE;
        let busy = running.has(schedule.id);
        if (due && !busy) {
          try {
            busy = await actions.isBusy?.(copy(schedule));
          } catch (error) {
            console.warn(tr('检查定时任务是否忙碌时出错：{0}', [error?.message ?? String(error)]));
          }
          // stop, remove or update may have invalidated the occurrence during isBusy.
          if (turn !== generation || !schedules.includes(schedule)) continue;
        }
        const missed = count - Number(due);
        if (missed) {
          const to = due ? previous : last;
          record(schedule.id, to, { status: 'missed', count: missed, from: first, to });
        }
        schedule.nextAt = nextTime(schedule.rule, at);
        if (schedule.rule.type === 'once') schedule.enabled = false;
        schedule.updatedAt = now();
        if (due) {
          schedule.lastRunAt = last;
          if (busy) record(schedule.id, last, { status: 'skipped', reason: 'busy' });
          else void perform(copy(schedule), last);
        }
        changed();
      }
    } finally {
      checking = false;
      arm();
    }
  }

  function editDone() {
    changed();
    arm();
  }

  return {
    list: () => schedules.map(copy),
    hasActive: () => schedules.some(s => s.enabled),
    add(def) {
      const at = now();
      const schedule = { ...checkedFields(def, at), id: randomUUID(), createdAt: at, updatedAt: at, lastRunAt: null };
      reschedule(schedule, at);
      schedules.push(schedule);
      editDone();
      return copy(schedule);
    },
    update(id, patch) {
      const old = find(id);
      const at = now();
      const fields = { ...old };
      for (const key of ['title', 'enabled', 'rule', 'action']) {
        if (Object.hasOwn(patch, key)) fields[key] = patch[key];
      }
      const schedule = { ...old, ...checkedFields(fields, at), updatedAt: at };
      if (!isDeepStrictEqual(old.rule, schedule.rule) || (!old.enabled && schedule.enabled)) reschedule(schedule, at);
      if (!schedule.enabled) schedule.nextAt = null;
      schedules[schedules.indexOf(old)] = schedule;
      editDone();
      return copy(schedule);
    },
    remove(id) {
      schedules.splice(schedules.indexOf(find(id)), 1);
      delete state.runs[id];
      editDone();
    },
    disable(id, reason) {
      const old = find(id);
      const at = now();
      schedules[schedules.indexOf(old)] = { ...old, enabled: false, nextAt: null, updatedAt: at };
      record(id, at, { status: 'disabled', reason });
      editDone();
    },
    runs(id) {
      const groups = id === undefined ? Object.values(state.runs) : [Object.hasOwn(state.runs, id) ? state.runs[id] : []];
      const records = groups.flat();
      records.reverse().sort((a, b) => b.ts - a.ts || (b.sequence ?? 0) - (a.sequence ?? 0));
      return structuredClone(records);
    },
    start() {
      if (started) return;
      started = true;
      if (!checking) return check();
    },
    stop() {
      started = false;
      generation++;
      cancelTimer();
    },
  };
}
