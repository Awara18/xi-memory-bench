/**
 * citation 日志（P4 第二根线）：这一回合到底端出了哪些记忆。
 *
 * 只追加、只记指针（id + 时间 + 来源），不抄正文。
 * 用途只有一个：学习控制器判断「这次纠正针对的是哪条被端出来的记忆」。
 * 没有这个文件，权重更新就只能靠猜，四天里 11 条纠正全被 hold 就是这个原因。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function citationsPath(storeDir) {
  return join(storeDir, 'citations.jsonl');
}

export function logCitations(storeDir, { conv, source, facts, raws, note }) {
  // 2026-11-25 21:3x：调这个函数的不止 ask（还有面板/脚本/别的 world），facts/raws 传成
  // 字符串或对象时 .map/.flatMap 直接抛，整条 citation 丢。只认数组，其他当没传。
  const factList = Array.isArray(facts) ? facts : [];
  const rawList = Array.isArray(raws) ? raws : [];
  const factIds = [...new Set(factList.map((f) => String((f && f.id) || '')).filter(Boolean))];
  const rawIds = [...new Set([
    ...rawList,
    ...factList.flatMap((f) => (Array.isArray(f && f.rawIds) ? f.rawIds : [])),
  ].map(String).filter(Boolean))];
  if (!factIds.length && !rawIds.length) return null;
  const row = {
    ts: new Date().toISOString(),
    conv: String(conv || ''),
    source: String(source || 'unknown'),
    factIds,
    rawIds,
  };
  if (note) row.note = String(note).slice(0, 120);
  try {
    mkdirSync(dirname(citationsPath(storeDir)), { recursive: true });
    appendFileSync(citationsPath(storeDir), JSON.stringify(row) + '\n');
    return row;
  } catch {
    return null;
  }
}

/** 读一段时间的 citation（学习控制器的只读入口，供测试/脚本用）。 */
export function readCitations(storeDir, { from, to } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const out = [];
  try {
    const text = readFileSync(citationsPath(storeDir), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const ts = Date.parse(row.ts);
        if (ts >= fromMs && ts <= toMs) out.push(row);
      } catch { /* skip */ }
    }
  } catch { /* no file */ }
  return out;
}
