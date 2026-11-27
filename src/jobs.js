/**
 * xi 自己的钟：到点把一条事件推进她自己的回合，不经过 QQ。
 *
 * 账本结构照 cortico-world-reminder@0.1.3（MIT）的 store.ts 简化：
 * JSON 原子写、坏文件不覆盖（读不出就当空，但保留原文件）。
 *
 * 调度算法来自 cortico-world-agenda@0.2.3（MIT）：cron/at/every 三选一，
 * 锚点 = 上次响过的时刻；错过只补一次，不连炸。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  anchorOf, checkEveryMinutes, formatAt, nextScheduled,
  missedSlots, parseAt, parseCron, scheduleText,
} from './schedule.js';

export const JOBS_FILE = 'jobs.json';
export const DEFAULT_QUIET_FROM = '23:00';
export const DEFAULT_QUIET_TO = '08:00';
export const MAX_JOB_TEXT = 1200;

function jobsPath(storeDir) { return join(storeDir, JOBS_FILE); }

function nowIso(at = new Date()) { return at.toISOString(); }

/**
 * 坏 jobs.json 不能直接当空账：先改名留档，再让调用方补默认 job。
 * 返回原名，调用方可据此写日志；改名失败返回 null（调用方仍会尝试重建）。
 */
function quarantineJobs(storeDir, reason) {
  const file = jobsPath(storeDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt-${stamp}`;
  try {
    renameSync(file, backup);
  } catch {
    return null;
  }
  try {
    appendFileSync(join(storeDir, 'jobs-corrupt.log'),
      `${new Date().toISOString()} ${reason} -> ${backup}\n`, 'utf8');
  } catch { /* 日志写不了不拦重建 */ }
  return backup;
}

export function readJobs(storeDir) {
  const file = jobsPath(storeDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) {
      quarantineJobs(storeDir, 'jobs.json 不是数组');
      return [];
    }
    return raw;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    quarantineJobs(storeDir, `jobs.json 读不出：${e && e.message || e}`);
    return [];
  }
}

export function writeJobs(storeDir, rows) {
  mkdirSync(storeDir, { recursive: true });
  const file = jobsPath(storeDir);
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(rows, null, 1) + String.fromCharCode(10), 'utf8');
  renameSync(tmp, file);
}

function nextJobId(rows) {
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.id || '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return 'j' + String(max + 1).padStart(4, '0');
}

function pickKind(input) {
  const hasCron = input.cron !== undefined && input.cron !== '';
  const hasAt = input.at !== undefined && input.at !== '';
  const hasEvery = input.everyMinutes !== undefined && input.everyMinutes !== '';
  const n = [hasCron, hasAt, hasEvery].filter(Boolean).length;
  if (n !== 1) return { ok: false, error: '节律三选一：cron（如 0 10 * * *）、at（YYYY-MM-DDTHH:mm）、everyMinutes（每 N 分钟）。' };
  if (hasCron) {
    try { parseCron(input.cron); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, kind: 'cron', cron: String(input.cron).trim() };
  }
  if (hasAt) {
    try { parseAt(input.at); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, kind: 'once', at: String(input.at).trim() };
  }
  const checked = checkEveryMinutes(input.everyMinutes);
  if (!checked.ok) return checked;
  return { ok: true, kind: 'every', everyMinutes: checked.minutes };
}

export function addJob({ storeDir, text, cron, at, everyMinutes, owner = 'agent', anchorAt, createdAt }) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: 'text 是空的：到点要做什么，写成一句能看懂的话。' };
  if (body.length > MAX_JOB_TEXT) return { ok: false, error: `text 最多 ${MAX_JOB_TEXT} 字。` };
  const kind = pickKind({ cron, at, everyMinutes });
  if (!kind.ok) return kind;
  const rows = readJobs(storeDir) ?? [];
  const job = {
    id: nextJobId(rows),
    text: body,
    kind: kind.kind,
    ...(kind.cron ? { cron: kind.cron } : {}),
    ...(kind.at ? { at: kind.at } : {}),
    ...(kind.everyMinutes ? { everyMinutes: kind.everyMinutes } : {}),
    enabled: true,
    owner: owner === 'deployer' ? 'deployer' : 'agent',
    createdAt: createdAt ?? nowIso(),
    anchorAt: anchorAt ?? nowIso(),
    lastFiredAt: '',
    lastScheduled: '',
    fireCount: 0,
  };
  rows.push(job);
  writeJobs(storeDir, rows);
  return { ok: true, job };
}

export function setJobEnabled({ storeDir, id, enabled }) {
  const rows = readJobs(storeDir) ?? [];
  const job = rows.find((j) => j.id === id);
  if (!job) return { ok: false, error: `没有 ${id}` };
  job.enabled = Boolean(enabled);
  if (job.enabled && !job.anchorAt) job.anchorAt = nowIso();
  writeJobs(storeDir, rows);
  return { ok: true, job };
}

export function removeJob({ storeDir, id }) {
  const rows = readJobs(storeDir) ?? [];
  const next = rows.filter((j) => j.id !== id);
  if (next.length === rows.length) return { ok: false, error: `没有 ${id}` };
  writeJobs(storeDir, next);
  return { ok: true, id };
}

function parseHm(raw, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? fallback));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function inQuietHours(now, from = DEFAULT_QUIET_FROM, to = DEFAULT_QUIET_TO) {
  const a = parseHm(from, DEFAULT_QUIET_FROM);
  const b = parseHm(to, DEFAULT_QUIET_TO);
  if (a === null || b === null || a === b) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

/** 此刻该响的 job；错过只算一次，不逐拍补。坏 job 跳过并回调，不拖垮别的 job。 */
export function dueJobs(storeDir, now = new Date(), quietFrom = DEFAULT_QUIET_FROM, quietTo = DEFAULT_QUIET_TO, onError = null) {
  if (inQuietHours(now, quietFrom, quietTo)) return [];
  const rows = readJobs(storeDir) ?? [];
  const out = [];
  for (const job of rows) {
    try {
      if (!job || !job.enabled) continue;
      const anchor = anchorOf(job);
      if (anchor === null) { if (onError) onError(job, new Error('没有锚点')); continue; }
      const scheduled = nextScheduled(job, anchor);
      if (scheduled === null) { if (onError) onError(job, new Error('算不出下次响铃')); continue; }
      if (scheduled.getTime() > now.getTime()) continue;
      const missed = missedSlots(job, anchor, now);
      out.push({ job, scheduled, missed, lateMs: Math.max(0, now.getTime() - scheduled.getTime()) });
    } catch (e) {
      if (onError) onError(job, e);
    }
  }
  return out;
}

/** 投递失败时把 job 状态原样放回去；下一次 tick 还能重试，不会静默少一拍。 */
export function restoreJob(storeDir, job) {
  const rows = readJobs(storeDir) ?? [];
  const at = rows.findIndex((j) => j.id === job.id);
  if (at < 0) return false;
  rows[at] = job;
  writeJobs(storeDir, rows);
  return true;
}

export function markJobFired(storeDir, job, scheduled, now = new Date()) {
  const rows = readJobs(storeDir) ?? [];
  const cur = rows.find((j) => j.id === job.id);
  if (!cur) return null;
  cur.anchorAt = nowIso(now);
  cur.lastFiredAt = nowIso(now);
  cur.lastScheduled = scheduled instanceof Date ? scheduled.toISOString() : String(scheduled ?? '');
  cur.lastDeliveredScheduled = cur.lastScheduled;
  cur.deliveredScheduled = [...new Set([...(cur.deliveredScheduled || []), cur.lastScheduled])].slice(-20);
  cur.fireCount = Number(cur.fireCount || 0) + 1;
  // 一次性 job 响过就停，不删记录（还能 list 到）。
  if (cur.kind === 'once') cur.enabled = false;
  writeJobs(storeDir, rows);
  return cur;
}

/** 同一 (jobId, scheduled) 已投过：只把锚点推过去，不再投、不再加 fireCount。 */
export function markJobSkipped(storeDir, job, scheduled, now = new Date()) {
  const rows = readJobs(storeDir) ?? [];
  const cur = rows.find((j) => j.id === job.id);
  if (!cur) return null;
  cur.anchorAt = nowIso(now);
  cur.lastScheduled = scheduled instanceof Date ? scheduled.toISOString() : String(scheduled ?? '');
  cur.skipCount = Number(cur.skipCount || 0) + 1;
  writeJobs(storeDir, rows);
  return cur;
}

const SELF_REVIEW_10 = [
  '【xi 自审 · 10:00】不用等谁开口。看四本账：',
  '1) open 承诺：有没有逾期/今天到期；',
  '2) 候选：有没有 review-due、试用到期、待签；',
  '3) 缺口：G 开头的还挂着几条，能不能补；',
  '4) 冲突：有没有 disputed 没解。',
  '只做 xi 里的动作，不发 QQ；做完在 action-log.jsonl 写一行。',
].join(String.fromCharCode(10));

const SELF_REVIEW_16 = [
  '【xi 自审 · 16:00】看回声账和上午的遗留：',
  '1) 回声账：no-reply 要不要追、pending 有没有该收的；',
  '2) 候选：review-due/待签/试用到期；',
  '3) 缺口：今天新记的能不能补；',
  '4) open 承诺：今天到期/逾期的再看一眼。',
  '只做 xi 里的动作，不发 QQ；做完在 action-log.jsonl 写一行。',
].join(String.fromCharCode(10));

function hasSelfReview(rows, marker) {
  return (rows || []).some((j) => String(j && j.text || '').includes(marker));
}

/**
 * 种自审 job：10:00 与 16:00 各一个。
 * jobs.json 已存在（哪怕空数组）也补缺，不覆盖用户自己加的 job。
 */
export function ensureDefaultJobs(storeDir, now = new Date()) {
  const existing = readJobs(storeDir) ?? [];
  const created = [];
  const want = [
    { marker: '【xi 自审 · 10:00】', text: SELF_REVIEW_10, cron: '0 10 * * *' },
    { marker: '【xi 自审 · 16:00】', text: SELF_REVIEW_16, cron: '0 16 * * *' },
  ];
  for (const w of want) {
    if (hasSelfReview(existing, w.marker)) continue;
    const added = addJob({
      storeDir, text: w.text, cron: w.cron, owner: 'agent',
      anchorAt: now.toISOString(),
    });
    if (added.ok) created.push(added.job);
  }
  return { ok: true, seeded: created.length > 0, jobs: readJobs(storeDir) ?? [], created };
}

export function formatJob(job, now = new Date()) {
  const anchor = anchorOf(job);
  const next = anchor ? nextScheduled(job, anchor) : null;
  const nextText = next ? formatAt(next) : '算不出';
  return `- ${job.id}｜${job.enabled ? '开' : '停'}｜${scheduleText(job)}｜下次 ${nextText}｜${job.text.replace(/\s+/g, ' ').slice(0, 80)}`;
}

export function formatJobList(storeDir, now = new Date()) {
  const rows = readJobs(storeDir);
  if (rows === null) return '（还没有 jobs.json，下次 tick 会种一个 10:00 自审）';
  if (!rows.length) return '（没有 job）';
  return rows.map((j) => formatJob(j, now)).join(String.fromCharCode(10));
}

/** 时钟显示：给工具回执用。 */
export function clockText(job) {
  return scheduleText(job);
}
