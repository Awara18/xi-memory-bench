// 只回原话的 brief：给一句线索，返回最多 N 条能直接引用的原话（谁/何时/行号）。
// 设计底线：不返回摘要、事实卡、教训、候选；找不到就说没有。宁可不提，不说错。
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_ID, SELF_ID, SELF_NAME } from './identity.js';

const MAX_TEXT = 400;
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '在', '有', '和', '就', '不', '也', '都', '这', '那', '吗', '呢', '吧', '啊', '把', '被', '给', '一个', '什么', '怎么']);

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  if (bad) out.badLines = bad;
  return out;
}

function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    if (!STOP.has(g)) set.add(g);
  }
  return set;
}

function overlap(a, b) {
  let n = 0;
  for (const g of a) if (b.has(g)) n += 1;
  return n;
}

function speakerName(row) {
  const s = row?.speaker;
  if (s?.name) return s.name;
  if (s?.id === 'self' || s?.id === 'xi' || (SELF_ID && s?.id === SELF_ID)) return SELF_NAME;
  if (MASTER_ID && s?.id === MASTER_ID) return '主人';
  return s?.id ? String(s.id) : '不明';
}

function clock(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间不明';
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function trim(text, max = MAX_TEXT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * @param {{storeDir:string, cue:string, limit?:number, excludeRecent?:number, scenes?:string[]}} opts
 * @returns {{lines:Array<{id:string,ts:string,speaker:string,text:string}>, text:string}}
 */
export function buildBrief(opts) {
  const { storeDir, cue, limit = 2, excludeRecent = 20, scenes = ['private', 'desktop'] } = opts || {};
  const file = path.join(storeDir, 'raw-log.jsonl');
  const rows = readRows(file);
  const q = bigrams(cue);
  const empty = { lines: [], text: '没有可引用的原话。不知道就说不知道，别凭印象补。' };
  if (q.size < 2) return empty;

  const cutoff = Math.max(0, rows.length - Math.max(0, excludeRecent));
  const scored = [];
  for (let i = 0; i < cutoff; i += 1) {
    const row = rows[i];
    if (!row || !row.text || row.duplicateOf) continue;
    if (!scenes.includes(row.scene)) continue;
    if (row.dir === 'out' && row.src === 'qq-sent' && !row.text) continue;
    // 排除“把检索结果/日志原样贴回来”的元消息，它们不是当时的原话。
    if (/【预激活|〔摘要|xi_preactivate|ask_xi|raw-log|grep_files|\[reply\]|XiBrief/i.test(row.text)) continue;
    if (row.text.length > 500) continue;
    const score = overlap(q, bigrams(row.text)) - row.text.length / 500;
    if (score < 2) continue;
    scored.push({ row, score, i });
  }
  scored.sort((a, b) => b.score - a.score || b.i - a.i);

  const picked = [];
  const seen = new Set();
  for (const { row } of scored) {
    const id = row.id ?? row.key ?? null;
    const text = trim(row.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    picked.push({ id: id ? String(id) : '', ts: row.ts, speaker: speakerName(row), text });
    if (picked.length >= Math.max(1, Math.min(3, limit))) break;
  }
  if (!picked.length) return empty;

  const lines = picked.map((p) => `[原话 · ${clock(p.ts)} · ${p.speaker}] “${p.text}”${p.id ? ` (${p.id})` : ''}`);
  return {
    lines: picked,
    text: [
      '【原话，可直接引用；不是摘要，不是候选】',
      ...lines,
      '引用前仍可用 xi_verify 核对；没写到的别补。',
    ].join('\n'),
  };
}
