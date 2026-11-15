// 同步快照中每个字段都带版本；空值表示记录已删除，防止旧设备恢复它。
type Versioned = { version: string; value: unknown };
export type Snapshot = { records: Record<string, Versioned>; settings: Record<string, Versioned> };
type Entry = { id: string; at: string; ml: number };
type User = { id: string; email: string };
const key = 'feedie.sync';
const version = () => `${String(Date.now()).padStart(13, '0')}-${crypto.randomUUID()}`;

// HTTP 状态用于识别会话过期和并发冲突，避免依赖界面文案。
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

// 将网络错误、未登录和服务端返回的错误交给界面显示。
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error || '请求失败', response.status);
  return result as T;
}

// 基于页面自己上次看到的快照计算变更，避免其他标签页的新数据被误判为删除。
export function trackChanges(entries: Entry[], prefs: object, previous: Snapshot, initial = false): Snapshot {
  const snapshot: Snapshot = { records: { ...previous.records }, settings: { ...previous.settings } };
  const nextVersion = () => initial ? '0000000000000-initial' : version();
  const current = Object.fromEntries(entries.map(entry => [entry.id, entry]));
  for (const [id, item] of Object.entries(current)) {
    if (JSON.stringify(snapshot.records[id]?.value) !== JSON.stringify(item)) snapshot.records[id] = { version: nextVersion(), value: item };
  }
  for (const [id, item] of Object.entries(snapshot.records)) {
    if (!(id in current) && item.value !== null) snapshot.records[id] = { version: nextVersion(), value: null };
  }
  for (const [name, value] of Object.entries(prefs)) {
    if (JSON.stringify(snapshot.settings[name]?.value) !== JSON.stringify(value)) snapshot.settings[name] = { version: nextVersion(), value };
  }
  return snapshot;
}

// 首次打开时恢复本地快照；之后用页面持有的快照计算本机变更。
export function track(entries: Entry[], prefs: object): Snapshot {
  const stored = localStorage.getItem(key);
  const snapshot = trackChanges(entries, prefs, stored ? JSON.parse(stored) : { records: {}, settings: {} }, !stored);
  localStorage.setItem(key, JSON.stringify(snapshot));
  return snapshot;
}

// 按字段的修改时间合并快照，记录的删除标记和普通修改同等处理。
function merge(local: Snapshot, remote: Snapshot): Snapshot {
  const merged: Snapshot = { records: {}, settings: {} };
  for (const section of ['records', 'settings'] as const) {
    for (const id of new Set([...Object.keys(local[section]), ...Object.keys(remote[section] || {})])) {
      const a = local[section][id], b = remote[section]?.[id];
      merged[section][id] = !a ? b : !b || a.version > b.version ? a : b;
    }
  }
  return merged;
}

// 每次提交使用服务器版本号；若另一设备先提交则重新读取并合并。
export async function syncData(user: User, local: Snapshot): Promise<Snapshot> {
  const owner = localStorage.getItem('feedie.sync.owner');
  if (owner && owner !== user.id) throw new Error('此设备的数据属于另一个账号，请使用原账号同步');
  for (let attempt = 0; attempt < 3; attempt++) {
    const cloud = await request<{ revision: number; data: Partial<Snapshot> }>('/api/sync');
    const remote = { records: cloud.data.records || {}, settings: cloud.data.settings || {} };
    const combined = merge(local, remote);
    // 定时拉取时，如果云端已经包含合并后的内容，就不增加数据库版本。
    const same = (['records', 'settings'] as const).every(section => {
      const keys = Object.keys(combined[section]);
      return keys.length === Object.keys(remote[section]).length && keys.every(id => JSON.stringify(combined[section][id]) === JSON.stringify(remote[section][id]));
    });
    if (same) { localStorage.setItem('feedie.sync.owner', user.id); return combined; }
    try {
      await request('/api/sync', 'PUT', { revision: cloud.revision, data: combined });
      localStorage.setItem('feedie.sync.owner', user.id);
      return combined;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
    }
  }
  throw new Error('多个设备正在同步，请稍后重试');
}

// 将已确认的快照写入本机，以免下一次同步误判为本机修改。
export function storeSnapshot(snapshot: Snapshot) { localStorage.setItem(key, JSON.stringify(snapshot)); }
// 网络请求期间本机可能继续修改，合并这些修改后再更新界面。
export function mergeSnapshots(local: Snapshot, remote: Snapshot) { return merge(local, remote); }
