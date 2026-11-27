/**
 * echo.js —— 回声账（总纲第 7 块）。
 *
 * 只做一件事：把「她说出去的那句」和「下一条入站」按同一个私聊会话配对。
 * 配对不判断对错，也不替她解释；它只是让「说完没人回」「回了但换了话题」
 * 这种事实有账可查。
 *
 * 规则（2026-11-23 v1）：
 * - 同私聊、出站后 30 分钟内的下一条入站；
 * - 连续出站只配最后一条，前面的标 superseded；
 * - 没人回，sweep 标 no-reply，单列，不进配对率分母；
 * - 群聊先不做；
 * - 换话题只标一栏，不剪路径。
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRawRows } from './store.js';

export const ECHO_FILE = 'echo-log.jsonl';
const DAY = 86400000;
export const PAIR_WINDOW_MS = 30 * 60 * 1000;

const iso = (v) => (v instanceof Date ? v : new Date(v ?? Date.now())).toISOString();

const BAD_ECHO_BACKED = new Set();
export function readEcho(storeDir) {
  const file = join(storeDir, ECHO_FILE);
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  if (bad) {
    try {
      const st = statSync(file);
      const key = `${file}|${st.size}|${st.mtimeMs}`;
      if (!BAD_ECHO_BACKED.has(key)) {
        BAD_ECHO_BACKED.add(key);
        copyFileSync(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      }
    } catch { /* 备份失败不拦读取 */ }
  }
  return rows;
}

function writeEcho(storeDir, rows) {
  mkdirSync(storeDir, { recursive: true });
  const f = join(storeDir, ECHO_FILE);
  const tmp = f + '.tmp-' + process.pid;
  writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ''), 'utf8');
  renameSync(tmp, f);
}

function nextId(rows) {
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.id || '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return 'e' + String(max + 1).padStart(4, '0');
}

const isPrivate = (conv) => String(conv || '').startsWith('private:');

/**
 * 出站时调用。连续出站只留最后一条可配：前一条 pending 标 superseded。
 */
export function recordOutboundEcho({ storeDir, rawId, conv = '', at } = {}) {
  if (!rawId || !isPrivate(conv)) return { ok: true, skipped: true, reason: 'not-private' };
  const rows = readEcho(storeDir);
  const atIso = iso(at);
  const atMs = Date.parse(atIso);
  const next = rows.map((r) => {
    if (!r || r.status !== 'pending' || r.conv !== conv) return r;
    const t = Date.parse(String(r.outAt || ''));
    if (Number.isFinite(t) && atMs - t <= PAIR_WINDOW_MS) {
      return { ...r, status: 'superseded', supersededBy: String(rawId), supersededAt: atIso, updatedAt: atIso };
    }
    return r;
  });
  const entry = {
    id: nextId(next),
    outRawId: String(rawId),
    conv: String(conv),
    outAt: atIso,
    inRawId: null,
    inAt: null,
    gapMs: null,
    topicShift: null,
    status: 'pending',
    createdAt: atIso,
    updatedAt: atIso,
  };
  next.push(entry);
  writeEcho(storeDir, next);
  return { ok: true, echo: entry };
}

/**
 * 旧账迁移：echo 只留指针，正文回 raw 取。
 * 默认 dry-run；--apply 才写。
 */
export function stripEchoText({ storeDir, apply = false } = {}) {
  const rows = readEcho(storeDir);
  let changed = 0;
  const next = rows.map((r) => {
    if (!r || !Object.prototype.hasOwnProperty.call(r, 'text')) return r;
    changed++;
    const { text, ...rest } = r;
    return rest;
  });
  if (apply && changed) writeEcho(storeDir, next);
  return { ok: true, changed, applied: !!apply, total: rows.length };
}

/**
 * 入站时调用。找同会话、30 分钟内、最近一条 pending，配给它。
 */
export function pairEcho({ storeDir, rawId, conv = '', text = '', at } = {}) {
  if (!rawId || !isPrivate(conv)) return { ok: true, skipped: true, reason: 'not-private' };
  const rows = readEcho(storeDir);
  const atIso = iso(at);
  const atMs = Date.parse(atIso);
  let hit = null;
  for (const r of rows) {
    if (!r || r.status !== 'pending' || r.conv !== conv) continue;
    const t = Date.parse(String(r.outAt || ''));
    if (!Number.isFinite(t) || atMs - t < 0 || atMs - t > PAIR_WINDOW_MS) continue;
    if (!hit || Date.parse(String(r.outAt)) > Date.parse(String(hit.outAt))) hit = r;
  }
  if (!hit) return { ok: true, paired: false };
  const norm = (v) => String(v || '').replace(/\s+/g, '');
  let outText = '';
  try {
    const raw = readRawRows(storeDir).find((r) => String(r.id || '') === String(hit.outRawId));
    outText = norm(raw && raw.text);
  } catch { /* raw 读不到就不标换话题 */ }
  const inText = norm(text);
  let topicShift = null;
  if (outText && inText) {
    const a = new Set(outText.slice(0, 120));
    const b = new Set(inText.slice(0, 120));
    const inter = [...a].filter((x) => b.has(x)).length;
    const jac = inter / Math.max(1, a.size + b.size - inter);
    topicShift = jac < 0.12 ? 'maybe' : 'no';
  }
  const updated = {
    ...hit,
    inRawId: String(rawId),
    inAt: atIso,
    gapMs: atMs - Date.parse(String(hit.outAt)),
    topicShift,
    status: 'paired',
    updatedAt: atIso,
  };
  writeEcho(storeDir, rows.map((r) => r.id === hit.id ? updated : r));
  return { ok: true, paired: true, echo: updated };
}

/** 超过 30 分钟还没回的 pending → no-reply。 */
export function sweepEcho({ storeDir, now } = {}) {
  const nowMs = new Date(now ?? Date.now()).getTime();
  const rows = readEcho(storeDir);
  let changed = 0;
  const at = iso(now);
  const next = rows.map((r) => {
    if (!r || r.status !== 'pending') return r;
    const t = Date.parse(String(r.outAt || ''));
    if (Number.isFinite(t) && nowMs - t > PAIR_WINDOW_MS) {
      changed++;
      return { ...r, status: 'no-reply', updatedAt: at, noReplyAt: at };
    }
    return r;
  });
  if (changed) writeEcho(storeDir, next);
  return { ok: true, changed, echoes: next };
}

export function echoStats({ storeDir, days = 7, now } = {}) {
  const nowMs = new Date(now ?? Date.now()).getTime();
  const since = nowMs - Math.max(1, Number(days) || 7) * DAY;
  const rows = readEcho(storeDir).filter((r) => {
    const t = Date.parse(String(r.outAt || ''));
    return Number.isFinite(t) && t >= since;
  });
  const paired = rows.filter((r) => r.status === 'paired').length;
  const noReply = rows.filter((r) => r.status === 'no-reply').length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  const superseded = rows.filter((r) => r.status === 'superseded').length;
  const pairEligible = paired + superseded + pending; // no-reply 单列
  return {
    ok: true, days: Number(days) || 7, total: rows.length,
    paired, noReply, pending, superseded,
    pairRate: pairEligible ? Number((paired / pairEligible).toFixed(4)) : null,
    method: 'echo-stats-v1',
  };
}

export function formatEcho(rows, { limit = 20 } = {}) {
  if (!rows.length) return '回声账是空的。';
  return rows.slice(-Math.max(1, Math.min(50, Number(limit) || 20))).map((r) => {
    const tail = r.status === 'paired'
      ? `→ ${r.inRawId}（${Math.round(Number(r.gapMs || 0) / 1000)}s${r.topicShift === 'maybe' ? '，可能换话题' : ''}）`
      : r.status === 'no-reply' ? '（没人回）' : r.status === 'superseded' ? `（后面还有出站，配了 ${r.supersededBy}）` : '（等回）';
    return `- ${r.id}｜${r.outAt.slice(0, 16).replace('T', ' ')}｜${r.outRawId}${tail}`;
  }).join(String.fromCharCode(10));
}
