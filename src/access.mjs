import assert from 'node:assert/strict';
import { t as tr } from './i18n.mjs';

export const ACCESS_RANK = Object.freeze({ read: 0, edit: 1, run: 2, full: 3 });
export const isAccessLevel = (value) => typeof value === 'string' && Object.hasOwn(ACCESS_RANK, value);

const READ_ONLY_ROLES = new Set(['coordinator', 'organizer', 'distill', 'handoff', 'import']);

export function assertTaskSpaceAccess(access) {
  if (access === 'read') {
    throw Object.assign(new Error(tr('任务空间需要修改文件交付结果，不能设为只读')), { status: 400 });
  }
}

export function resolveTurnAccess({
  spaceKind = 'chat', spaceAccess = 'edit', role = 'chat', isApi = false, supportsApproval = false, folderLocked = false,
} = {}) {
  if (!isAccessLevel(spaceAccess)) throw new Error(tr('无效的空间权限'));
  if (role === 'task-worker' && spaceAccess === 'read') throw new Error(tr('任务空间不能使用只读权限'));

  let access = folderLocked || READ_ONLY_ROLES.has(role) ? 'read' : spaceAccess;
  let asks = false;
  // 聊天的 run 档逐条审批，任务执行者按任务空间的权限直接运行。
  if (spaceKind === 'chat' && role === 'chat' && access === 'run' && !isApi) {
    asks = !!supportsApproval;
    if (!asks) access = 'edit';
  }
  assert(ACCESS_RANK[access] <= ACCESS_RANK[spaceAccess], tr('本轮权限不能高于空间权限'));
  return { access, asks };
}
