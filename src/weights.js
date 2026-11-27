/**
 * 记忆权重的只读视图（P4 第一根线）。
 *
 * 账本归学习控制器（workspace/xi-learn/records/weights.jsonl），xi 只读。
 * 权重只影响「主动端出来的顺序」，不改变事实是否成立，也不参与回答判定。
 * 没账本、没这条 → 默认 50（因子 1.0），行为跟以前一样。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WEIGHT_DEFAULT = 50;
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 100;

let cache = { key: '', map: new Map() };

export function weightsPath(storeDir) {
  return join(dirname(storeDir), 'xi-learn', 'records', 'weights.jsonl');
}

export function loadWeights(storeDir) {
  const file = weightsPath(storeDir);
  let key = file;
  try {
    const st = statSync(file);
    key = `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    return new Map();
  }
  if (cache.key === key) return cache.map;
  const map = new Map();
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // 2026-11-25 21:3x：账本里 to 缺失/写成 null 时 Number(null) 是 0，会被当成
        // 「权重 0」把这条记忆压到最低；只有真正是数字的才收，其余保持默认 50。
        if (row && row.factId) {
          const n = Number(row.to);
          if (Number.isFinite(n) && row.to !== null && row.to !== '') map.set(String(row.factId), n);
        }
      } catch { /* 单行坏了跳过，不影响其他 */ }
    }
  } catch { /* 读不到就当没有 */ }
  cache = { key, map };
  return map;
}

export function weightOf(storeDir, factId) {
  const w = loadWeights(storeDir).get(String(factId));
  return Number.isFinite(w) ? w : WEIGHT_DEFAULT;
}

/** 50 → 1.0，0 → 0.5，100 → 1.5。只乘在排序分上。 */
export function weightFactor(storeDir, factId) {
  const w = weightOf(storeDir, factId);
  return 0.5 + Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w)) / 100;
}
