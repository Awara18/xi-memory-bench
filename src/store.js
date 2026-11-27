/**
 * store.js —— xi 的只读底座：raw-log / facts / plans / summary 的读取与小工具。
 *
 * 只读。verify 和 recap 都从这里拿数据，不碰 World 状态、不写库。
 * 2026-11-22 18:1x：我说「写进去的东西当场读不到」——所以 verify/recap 必须能
 * 每一轮被工具调用，不能指望前缀快照。
 */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** 去掉空白和标点，只留字；算字面重合用。 */
export const stripPunct = (s) => norm(s).replace(/[\s\p{P}\p{S}]/gu, '');

export function bigrams(s) {
  const t = stripPunct(s);
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

/** claim 的字二元组有多少落在 text 里（召回率，不是 Jaccard）。 */
export function overlap(claim, text) {
  const a = bigrams(claim);
  const b = bigrams(text);
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

/** ISO/epoch → 上海本地「2026-11-22 17:20」。 */
export function localStamp(ts) {
  if (ts == null || ts === '') return '';
  const d = new Date(typeof ts === 'number' ? ts : String(ts));
  if (Number.isNaN(d.getTime())) return norm(ts).slice(0, 16).replace('T', ' ');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 上海本地今天 YYYY-MM-DD。 */
export function todayLocal(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now instanceof Date ? now : new Date(now)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function daysBetween(from, to) {
  const a = Date.parse(String(from) + 'T00:00:00Z');
  const b = Date.parse(String(to) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

const BAD_JSON_BACKED = new Set();

/**
 * 读 JSONL；坏行跳过，但**先把原文件留一份 .corrupt-* 备份**。
 * 否则下一次 writeAll 用过滤后的行整本重写，坏行就永久没了。
 */
export function readJsonl(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/);
  const rows = [];
  let bad = 0;
  for (const line of lines) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  if (bad) {
    try {
      const st = statSync(file);
      const key = `${file}|${st.size}|${st.mtimeMs}`;
      if (!BAD_JSON_BACKED.has(key)) {
        BAD_JSON_BACKED.add(key);
        // 备份名按内容哈希，不按时间：同一份坏文件反复读/重启，
        // 不能每次进程启动都复制一份新的，否则坏行不清就会无限长备份。
        const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
        const backup = `${file}.corrupt-${digest}`;
        if (!existsSync(backup)) copyFileSync(file, backup);
      }
    } catch { /* 备份失败不拦读取 */ }
  }
  return rows;
}

/** raw-log 行，带 1 基行号 `_line`；坏行跳过，不炸。 */
export function readRawRows(storeDir) {
  const rows = [];
  try {
    const lines = readFileSync(join(storeDir, 'raw-log.jsonl'), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try { rows.push({ ...JSON.parse(lines[i]), _line: i + 1 }); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 没库就是空 */ }
  return rows;
}

export function readFacts(storeDir) {
  return readJsonl(join(storeDir, 'facts.jsonl'));
}

export function readPlans(storeDir) {
  return readJsonl(join(storeDir, 'plans.jsonl'));
}

/** summary.md 最后一个 ### 段；没有就取最后 600 字。 */
export function readLastSummary(storeDir) {
  let text = '';
  try { text = readFileSync(join(storeDir, 'summary.md'), 'utf8'); } catch { return null; }
  const blocks = text.split(/^### /m).filter((b) => b.trim());
  if (!blocks.length) return { stamp: '', text: norm(text).slice(-600) };
  const last = blocks[blocks.length - 1];
  const nl = last.indexOf('\n');
  const stamp = nl < 0 ? norm(last) : norm(last.slice(0, nl));
  const body = nl < 0 ? '' : last.slice(nl + 1).trim();
  return { stamp, text: body.slice(0, 800) };
}
