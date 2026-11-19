// 调用一次 AI：聊天发言和任务协作共用。
// 负责把流式输出、工具动作、原始日志写进 sink，并处理 API 型 AI 的文件块（按权限写入共享文件夹）。
// 不关心调用方是谁：中止（signal）、会话续接的重试、事件推送都由调用方决定。
import { t as tr } from './i18n.mjs';
import { extractFileBlocks } from './engines/file-blocks.mjs';

const MAX_LOG_LINE = 2000;

/**
 * @param registry  引擎注册表
 * @param member    成员（engine / model / effort / name）
 * @param opts.system / prompt / cwd / access / sessionId / fork / resumeAt / signal   传给引擎（fork：复制一份会话再接；resumeAt：只复制到这条消息）
 * @param opts.sink         写入对象：{ text, activities, note?, log? }；有 log 数组时记录原始输出
 * @param opts.ws           API 型 AI 的文件块写到哪个 Workspace；不给则不写入
 * @param opts.maxActivities / maxLog   保留的动作条数、日志行数
 * @param opts.onDelta / onActivity     sink 更新之后的回调（用于推送事件）
 * @param opts.onApproval   运行命令前先问（只传给支持审批的引擎；不传就按权限直接运行）
 * @returns 引擎的返回值，其中 text 已去掉文件块
 */
export async function runAgentTurn(registry, member, {
  system, prompt, cwd, access, sessionId, fork, resumeAt, signal,
  sink, ws = null, maxActivities = 60, maxLog = 600,
  onDelta, onActivity, onApproval, images = [], onNoImages,
}) {
  sink.activities ||= [];
  const markNoImages = () => { sink.noImages = true; onNoImages?.(); };
  const canSee = images.length && registry.supportsImages(member.engine);
  if (images.length && !canSee) markNoImages();
  const r = await registry.runTurn(member.engine, {
    ...(canSee ? { images, onNoImages: markNoImages } : {}),
    system,
    prompt,
    model: member.model,
    effort: member.effort,
    cwd,
    access,
    sessionId,
    fork,
    resumeAt,
    signal,
    onApproval,
    onDelta: (t) => { sink.text = (sink.text || '') + t; onDelta?.(t); },
    onActivity: (a) => {
      sink.activities.push(a);
      if (sink.activities.length > maxActivities) sink.activities.splice(0, sink.activities.length - maxActivities);
      onActivity?.(a);
    },
    onRaw: sink.log ? (line) => {
      sink.log.push(line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line);
      if (sink.log.length > maxLog) sink.log.splice(0, sink.log.length - maxLog);
    } : undefined,
  });
  const text = registry.isApi(member.engine) ? applyFileBlocks(r.text, { member, ws, access, sink }) : r.text;
  return { ...r, text };
}

/** API 型 AI 的回复：取出文件块写入共享文件夹，返回剩下的文字。 */
function applyFileBlocks(reply, { member, ws, access, sink }) {
  const { text, files } = extractFileBlocks(reply);
  if (!files.length) return text;
  if (!ws || access === 'read') {
    sink.note = tr('{0} 想修改 {1}，但当前是只读权限，没有写入。', [member.name, files.map((f) => f.path).join('、')]);
    return text;
  }
  for (const f of files) {
    try {
      ws.writeRaw(f.path, f.content);
      sink.activities.push({ kind: 'edit', label: tr('修改 {0}', [f.path]) });
    } catch (e) {
      sink.note = tr('没能写入 {0}：{1}', [f.path, e.message]);
    }
  }
  return text;
}
