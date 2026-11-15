// 备份中的单条喂养记录：id 保持不变，供重复导入和跨设备同步去重。
export type ImportedEntry = { id: string; at: string; ml: number };

// 只接受 Feedie 导出的 v1 文件；全部校验通过后才返回记录，避免部分导入。
export function parseRecords(text: string): ImportedEntry[] {
  let backup: unknown;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON");
  }
  if (!backup || typeof backup !== "object" || Array.isArray(backup) || !("version" in backup) || backup.version !== 1 || !("entries" in backup) || !Array.isArray(backup.entries)) {
    throw new Error("不支持此备份格式，请选择 Feedie 导出的 JSON 文件");
  }

  return backup.entries.map((value: unknown, index: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`第 ${index + 1} 条记录格式不正确`);
    const entry = value as Record<string, unknown>;
    // 普通对象被用于同步记录索引，这些特殊键不能安全地作为记录 ID。
    if (typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 256 || entry.id in Object.prototype || entry.id === "__proto__" || entry.id === "prototype" || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)) || typeof entry.ml !== "number" || !Number.isFinite(entry.ml) || entry.ml < 0) {
      throw new Error(`第 ${index + 1} 条记录格式不正确`);
    }
    return { id: entry.id, at: entry.at, ml: entry.ml };
  });
}
