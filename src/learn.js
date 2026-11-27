/**
 * learn.js —— 学习候选账（总纲第 5 块的第一步：先只收 lesson）。
 *
 * 原则（2026-11-23 定）：
 * - 候选不是事实：只写 learning/candidates.jsonl，不参加 ask_xi / preactivate。
 * - 来源只认原话、回执、gate/verify/承诺失败；不学自己的摘要和未验证出站。
 * - origin 由调用方代码判，模型入参只能声明，不能自封。
 * - 转正只有一条路：pending → show → master-raw 同意 → approved → promote。
 * - 生命周期不物理删：active → review-due → stale → archived，可 restore。
 *
 * 这里只碰文件，不碰 World 状态。所有函数同步，方便 CLI / 工具 / 测试共用。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MASTER_NAMES } from './identity.js';
import { readJsonl, readRawRows, norm } from './store.js';
import { writeFactRow } from './facts.js';

export const CANDIDATES_FILE = 'learning/candidates.jsonl';
export const LESSONS_FILE = 'lessons.jsonl';
export const REVIEW_LOG_FILE = 'review-log.jsonl';
export const CONFLICTS_FILE = 'conflicts.jsonl';
export const GAPS_FILE = 'gaps.jsonl';
export const PREFERENCES_FILE = 'preferences.jsonl';
export const BOOKS_DIR = 'books';

const DAY = 86400000;
const DAILY_CANDIDATE_CAP = 5;   // 每天最多新增 5 条候选
const CANDIDATE_QUEUE_CAP = 30;  // 未结候选队列最多 30 条
const OPEN_SHOW_CAP = 2;         // 同时最多 2 条待签，避免一口气铺一屏
const KINDS = new Set(['lesson', 'preference', 'fact', 'rule', 'skill', 'reading']);
const RISKS = new Set(['low', 'medium', 'high']);
const VERIFY = new Set(['unverified', 'user-confirmed', 'externally-verified', 'falsified']);
const SOURCE_KINDS = new Set(['raw', 'receipt', 'gate', 'verify', 'promise', 'failure', 'book', 'url']);
const ORIGINS = new Set(['inbound', 'outbound', 'gate', 'verify', 'receipt', 'reading', 'manual']);

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
const addDays = (days, now) => new Date(new Date(now ?? Date.now()).getTime() + days * DAY).toISOString();
const file = (storeDir, rel) => join(storeDir, rel);

function ensureDir(storeDir) {
  mkdirSync(join(storeDir, 'learning'), { recursive: true });
}

function readAll(storeDir, rel) {
  return readJsonl(file(storeDir, rel));
}

function appendOne(storeDir, rel, obj) {
  ensureDir(storeDir);
  const f = file(storeDir, rel);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(obj) + String.fromCharCode(10), 'utf8');
}

function writeAll(storeDir, rel, rows) {
  ensureDir(storeDir);
  const f = file(storeDir, rel);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ''), 'utf8');
  renameSync(tmp, f);
}

function nextId(rows, prefix, width = 4) {
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.id || '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return prefix + String(max + 1).padStart(width, '0');
}

function shanghaiDay(value) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function readRowsFile(storeDir, rel) {
  return readJsonl(file(storeDir, rel));
}

function appendRowsFile(storeDir, rel, obj) {
  appendOne(storeDir, rel, obj);
}

function rawAnchorOf(source) {
  const anchors = Array.isArray(source && source.anchors) ? source.anchors : [];
  return anchors.find((a) => /^r\d+$/i.test(String(a))) || '';
}

function validateKindSource(kind, source, text) {
  if (kind === 'preference') {
    if (source.kind !== 'raw') return { ok: false, error: 'preference 只能从原话来（source.kind=raw）' };
    if (source.speaker !== 'self') return { ok: false, error: 'preference 是我自己的偏好，source.speaker 必须是 self' };
    if (!/(我[\s\S]{0,12}(喜欢|不喜欢|讨厌|爱|习惯|偏好|怕|想要|不想|更愿意))/.test(text)) {
      return { ok: false, error: 'preference 要写成「我喜欢/我不喜欢/我习惯…」这种明确偏好句' };
    }
  }
  if (kind === 'fact' || kind === 'rule') {
    if (source.kind !== 'raw') return { ok: false, error: `${kind} 转正必须能从原话指回（source.kind=raw）` };
    if (!rawAnchorOf(source)) return { ok: false, error: `${kind} 要给 rawId 锚（r000123）` };
  }
  if (kind === 'reading') {
    if (!['book', 'url'].includes(source.kind)) return { ok: false, error: 'reading 只能从书/网页来（book/url）' };
  }
  if (kind === 'skill') {
    if (source.kind !== 'receipt') return { ok: false, error: 'skill 必须有成功回执（receipt）' };
  }
  return { ok: true };
}

function identityOf(storeDir) {
  try { return JSON.parse(readFileSync(join(storeDir, 'identity.json'), 'utf8')); } catch { return null; }
}

function masterNames(storeDir) {
  const id = identityOf(storeDir) || {};
  return [...new Set([...(id.master?.names || []), ...MASTER_NAMES].filter(Boolean))];
}

function isMasterRow(row, storeDir) {
  if (!row || row.dir !== 'in') return false;
  const id = String(row.speaker?.id || '');
  const name = String(row.speaker?.name || '');
  const masterQq = String(identityOf(storeDir)?.master?.qq || '');
  if (masterQq && id && id === masterQq) return true;
  return masterNames(storeDir).some((n) => name === n);
}

export function validateLesson(lesson) {
  if (!lesson || typeof lesson !== 'object') return { ok: false, error: 'lesson 必须是对象：symptom/rootCause/detour/resolution/prevention/notWhen' };
  const fields = ['symptom', 'rootCause', 'detour', 'resolution', 'prevention', 'notWhen'];
  for (const k of fields) {
    if (!String(lesson[k] ?? '').trim()) return { ok: false, error: `lesson.${k} 不能为空` };
  }
  const prevention = String(lesson.prevention).trim();
  if (!/遇到[\s\S]{0,60}?先/.test(prevention)) {
    return { ok: false, error: 'lesson.prevention 要写成「遇到…先…」' };
  }
  if (String(lesson.notWhen).trim().length < 4) {
    return { ok: false, error: 'lesson.notWhen 要写清什么时候不适用（至少 4 个字）' };
  }
  return { ok: true };
}

function normalizeSource(source) {
  const s = source && typeof source === 'object' ? source : {};
  const kind = String(s.kind || '').trim();
  if (!SOURCE_KINDS.has(kind)) return { ok: false, error: `来源 kind 只能是 ${[...SOURCE_KINDS].join(' / ')}` };
  const anchors = Array.isArray(s.anchors) ? s.anchors.map((x) => String(x).trim()).filter(Boolean) : [];
  if (['raw', 'book', 'url', 'receipt'].includes(kind) && !anchors.length) {
    return { ok: false, error: `来源 ${kind} 必须给 anchors` };
  }
  const speaker = s.speaker === 'self' ? 'self' : 'master';
  if (kind === 'raw' && !['master', 'self'].includes(speaker)) return { ok: false, error: 'raw 来源要写 speaker=master|self' };
  return {
    ok: true,
    source: {
      kind,
      anchors,
      speaker,
      quote: String(s.quote ?? '').trim().slice(0, 600),
    },
  };
}

export function readCandidates(storeDir) {
  return readAll(storeDir, CANDIDATES_FILE);
}

export function readLessons(storeDir) {
  return readAll(storeDir, LESSONS_FILE);
}

export function readConflicts(storeDir) {
  return readAll(storeDir, CONFLICTS_FILE);
}

export function readGaps(storeDir) {
  return readAll(storeDir, GAPS_FILE);
}

export function readReviewLog(storeDir) {
  return readAll(storeDir, REVIEW_LOG_FILE);
}

export function readPreferences(storeDir) {
  return readAll(storeDir, PREFERENCES_FILE);
}

export const PREF_SCAN_FILE = 'learning/preference-scan.json';
const PREF_SCAN_WINDOW = 400;
const PREF_STRICT = /我(?:其实|本来|一向|一直|真的|确实|也|更|最|挺|很|不|有点)?(?:喜欢|不喜欢|讨厌|习惯|偏好|更愿意)/;
const PREF_TRANSIENT = /(今天|今晚|刚才|现在|这一刻|这会儿|这次|有点|突然|一时|暂时|刚刚)/;
const PREF_QUESTION = /[?？]|(?:吗|么|呢)[。！!]?$/;

function isSelfRow(row, storeDir) {
  if (!row || row.dir !== 'out') return false;
  const id = String(row.speaker?.id || '');
  const name = String(row.speaker?.name || '');
  const self = identityOf(storeDir)?.self || {};
  if (id === 'self') return true;
  if (self.qq && id === String(self.qq)) return true;
  return name === (self.name || '我');
}

function preferenceSentence(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const parts = raw.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  for (const part of parts) {
    let s = part.trim().replace(/^[，,、；;：:\s]+/, '');
    if (s.length < 6 || s.length > 160) continue;
    if (PREF_QUESTION.test(s)) continue;
    if (PREF_TRANSIENT.test(s)) continue;
    if (/^我(?:怕|担心)(?:你|他|她)/.test(s)) continue;
    if (!/^(?:其实|不过|反正|所以|嗯|而且|但是|可|只是)?我/.test(s)) continue;
    if (!PREF_STRICT.test(s)) continue;
    return s.slice(0, 160);
  }
  return null;
}

/**
 * 从最近的 raw-log 里找我自己的明确偏好句，只产 preference 候选。
 * 不转正、不进 facts；每天/队列配额仍由 addCandidate 卡。
 * apply=false 只预览，不写候选也不更新游标。
 */
export function autoPreferenceScan({ storeDir, window = PREF_SCAN_WINDOW, limit = 3, now, apply = true } = {}) {
  const stateFile = file(storeDir, PREF_SCAN_FILE);
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) || {}; } catch { state = {}; }
  const rows = readRawRows(storeDir);
  if (!rows.length) return { ok: true, scanned: 0, added: 0, candidates: [], lastLine: state.lastLine ?? null };
  const lastLine = Number(state.lastLine || 0);
  let pool = lastLine > 0 ? rows.filter((r) => Number(r._line || 0) > lastLine) : rows.slice(-window);
  // 首次只扫最近 window 行，避免把几个月前的旧话一次翻成候选。
  if (!pool.length && lastLine === 0) pool = rows.slice(-window);
  const candidates = [];
  let scanned = 0;
  for (const row of pool) {
    scanned++;
    if (!isSelfRow(row, storeDir)) continue;
    const text = preferenceSentence(row.text);
    if (!text) continue;
    const source = { kind: 'raw', anchors: [String(row.id || '')].filter(Boolean), speaker: 'self', quote: String(row.text || '').slice(0, 600) };
    if (!source.anchors.length) continue;
    if (!apply) {
      candidates.push({ text, source, origin: 'outbound', risk: 'low' });
    } else {
      const r = addCandidate({ storeDir, kind: 'preference', text, source, origin: 'outbound', risk: 'low', verification: 'unverified', now });
      if (r.ok && !r.duplicate) candidates.push(r.candidate);
    }
    if (candidates.length >= limit) break;
  }
  const newLast = Number(rows[rows.length - 1]._line || lastLine);
  if (apply) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ lastLine: newLast, updatedAt: iso(now) }, null, 2) + String.fromCharCode(10), 'utf8');
    } catch { /* 游标写不上不挡采集，下次会重扫，addCandidate 会去重 */ }
  }
  return { ok: true, scanned, added: candidates.length, candidates, lastLine: newLast };
}

export function addCandidate({ storeDir, kind = 'lesson', text, lesson, source, origin = 'manual', risk = 'medium', verification = 'unverified', failureKey = '', answerFor = null, now } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'text 是空的' };
  if (!KINDS.has(kind)) return { ok: false, error: `kind 只能是 ${[...KINDS].join(' / ')}` };
  if (!RISKS.has(risk)) return { ok: false, error: 'risk 只能是 low / medium / high' };
  if (!VERIFY.has(verification)) return { ok: false, error: 'verification 只能是 unverified / user-confirmed / externally-verified / falsified' };
  if (!ORIGINS.has(origin)) return { ok: false, error: `origin 只能是 ${[...ORIGINS].join(' / ')}` };
  if (kind === 'lesson') {
    const v = validateLesson(lesson);
    if (!v.ok) return v;
  }
  const src = normalizeSource(source);
  if (!src.ok) return src;
  const sv = validateKindSource(kind, src.source, t);
  if (!sv.ok) return sv;
  const rows = readCandidates(storeDir);
  // 配额：每天最多 5 条候选；未结队列最多 30 条。不是建议，是硬上限。
  const today = shanghaiDay(now);
  const todayCount = rows.filter((c) => c && shanghaiDay(c.createdAt) === today).length;
  if (todayCount >= DAILY_CANDIDATE_CAP) {
    return { ok: false, error: `今天候选已经 ${todayCount} 条，到上限 ${DAILY_CANDIDATE_CAP} 条了；明天再收，或先处理已有的` };
  }
  const openCount = rows.filter((c) => c && !['promoted', 'rejected', 'archived'].includes(c.status)).length;
  if (openCount >= CANDIDATE_QUEUE_CAP) {
    return { ok: false, error: `未结候选已有 ${openCount} 条，到队列上限 ${CANDIDATE_QUEUE_CAP} 条；先清理再收` };
  }
  const dup = rows.find((c) => c && c.kind === kind && c.text === t
    && JSON.stringify(c.source || {}) === JSON.stringify(src.source));
  if (dup) return { ok: true, candidate: dup, duplicate: true };
  const id = nextId(rows, 'L');
  const at = iso(now);
  const c = {
    id,
    kind,
    text: t,
    lesson: kind === 'lesson' ? {
      symptom: String(lesson.symptom).trim(),
      rootCause: String(lesson.rootCause).trim(),
      detour: String(lesson.detour).trim(),
      resolution: String(lesson.resolution).trim(),
      prevention: String(lesson.prevention).trim(),
      notWhen: String(lesson.notWhen).trim(),
    } : null,
    source: src.source,
    origin,
    risk,
    verification,
    status: 'pending',
    occurrences: 1,
    createdAt: at,
    updatedAt: at,
    reviewAt: null,
    approvedBy: null,
    promotedTo: null,
    promotedId: null,
    lastShownAt: null,
    lastShowRawId: null,
    ...(failureKey ? { failureKey: String(failureKey).slice(0, 300) } : {}),
    ...(answerFor ? { answerFor: Array.isArray(answerFor) ? answerFor : [String(answerFor)] } : {}),
    rejectedAt: null,
    rejectReason: '',
    history: [{ at, event: 'add' }],
  };
  appendOne(storeDir, CANDIDATES_FILE, c);
  return { ok: true, candidate: c };
}

function openShow(storeDir, candidateId) {
  const log = readReviewLog(storeDir);
  let last = null;
  let approved = false;
  let invalidated = false;
  for (const e of log) {
    if (!e || e.candidateId !== candidateId) continue;
    if (e.event === 'show') { last = e; approved = false; invalidated = false; }
    else if (e.event === 'approve') approved = true;
    else if (e.event === 'show-invalidated') invalidated = true;
  }
  if (!last || approved || invalidated) return null;
  return last;
}

function invalidateOpenShows(storeDir, reason, exceptId = '') {
  const log = readReviewLog(storeDir);
  const seen = new Set();
  for (const e of log) {
    if (!e || !e.candidateId || e.candidateId === exceptId) continue;
    if (e.event === 'show') seen.add(e.candidateId);
    else if (e.event === 'approve' || e.event === 'show-invalidated') seen.delete(e.candidateId);
  }
  for (const id of seen) {
    const c = readCandidates(storeDir).find((x) => x.id === id);
    if (!c) continue;
    appendOne(storeDir, REVIEW_LOG_FILE, {
      event: 'show-invalidated', candidateId: id, reason,
      at: iso(), lastShowAt: c.lastShownAt || '', lastShowRawId: c.lastShowRawId || '',
    });
  }
  return [...seen];
}

export function showCandidate({ storeDir, id, outRawId = '', conv = '', now } = {}) {
  const cid = String(id || '').trim();
  const rows = readCandidates(storeDir);
  const c = rows.find((x) => x.id === cid);
  if (!c) return { ok: false, error: `找不到候选 ${cid}` };
  if (!['pending', 'approved'].includes(c.status)) return { ok: false, error: `候选状态是 ${c.status}，不能展示` };
  const openNow = rows.filter((x) => openShow(storeDir, x.id)).length;
  if (openNow >= OPEN_SHOW_CAP) return { ok: false, error: `同时最多 ${OPEN_SHOW_CAP} 条待签；先把已有的签掉或作废，再展示新的` };
  invalidateOpenShows(storeDir, 'new-show', cid);
  const at = iso(now);
  appendOne(storeDir, REVIEW_LOG_FILE, {
    event: 'show', candidateId: cid, outRawId: String(outRawId || ''),
    conv: String(conv || ''), at,
  });
  const next = rows.map((x) => x.id === cid ? { ...x, lastShownAt: at, lastShowRawId: String(outRawId || ''), updatedAt: at } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  return { ok: true, candidate: next.find((x) => x.id === cid), text: formatCandidate(c, { show: true }) };
}

function normalizeAgree(s) {
  return norm(s).replace(/[\s\p{P}\p{S}]/gu, '');
}

export function approveCandidate({ storeDir, id, rawId, shownRawId = '', now } = {}) {
  const cid = String(id || '').trim();
  const rid = String(rawId || '').trim();
  if (!cid || !rid) return { ok: false, error: 'approve 需要 id 和 rawId' };
  const rows = readCandidates(storeDir);
  const c = rows.find((x) => x.id === cid);
  if (!c) return { ok: false, error: `找不到候选 ${cid}` };
  if (c.status === 'approved') return { ok: true, candidate: c, already: true };
  if (c.status !== 'pending') return { ok: false, error: `候选状态是 ${c.status}，不能签` };

  const show = openShow(storeDir, cid);
  if (!show) return { ok: false, error: '没有有效的展示记录；先 show 一次，再让主人回话' };
  const shown = String(shownRawId || show.outRawId || '').trim();
  if (show.outRawId && shown && show.outRawId !== shown) {
    return { ok: false, error: `签名绑定的展示不是这条：show.outRawId=${show.outRawId}，你给的是 ${shown}` };
  }

  const raw = readRawRows(storeDir);
  const apprRow = raw.find((r) => r.id === rid);
  if (!apprRow) return { ok: false, error: `rawId ${rid} 不在 raw-log 里` };
  if (!isMasterRow(apprRow, storeDir)) return { ok: false, error: '签字只认主人本人的入站原话' };

  let showRow = null;
  if (show.outRawId) showRow = raw.find((r) => r.id === show.outRawId);
  const showAt = Date.parse(show.at);
  let start = -1;
  if (showRow) start = raw.indexOf(showRow);
  else if (Number.isFinite(showAt)) {
    for (let i = 0; i < raw.length; i++) {
      const t = Date.parse(String(raw[i].ts || raw[i].tsUtc || ''));
      if (Number.isFinite(t) && t <= showAt) start = i;
    }
  }
  if (start < 0) return { ok: false, error: '找不到展示对应的 raw-log 位置' };
  const apprIdx = raw.indexOf(apprRow);
  if (apprIdx <= start) return { ok: false, error: '签字必须发生在展示之后' };

  const between = raw.slice(start + 1, apprIdx);
  const otherIn = between.filter((r) => r && r.dir === 'in');
  if (otherIn.length) {
    appendOne(storeDir, REVIEW_LOG_FILE, {
      event: 'show-invalidated', candidateId: cid, reason: '岔题：展示之后、签字之前还有别的入站',
      at: iso(now), blockedBy: otherIn.map((r) => r.id).slice(0, 5),
    });
    return { ok: false, error: '展示之后中间岔过别的入站（' + otherIn.map((r) => r.id).join(', ') + '），这次签字作废；要签重新 show 一次' };
  }

  const txt = normalizeAgree(apprRow.text);
  if (!txt || txt.length > 24 || /[?？]/.test(String(apprRow.text || ''))) {
    return { ok: false, error: '签字回话要短、只回同意，不带问题或别的话题' };
  }
  if (/(不|没|别|拒绝|算了|等等|等一下|但是|不过|可是|换个|别的|不行|不同意|不签)/.test(txt)) {
    return { ok: false, error: '签字回话里带否定/岔开词，不能当同意' };
  }
  const core = txt.replace(/(同意|可以|行|好|签了|签|转正|按这个来|批准|通过|嗯|收到)/g, '');
  if (core) return { ok: false, error: `签字回话里除了同意还有别的内容「${core}」，不能当只针对这条` };
  if (!/(同意|可以|行|好|签了|签|转正|按这个来|批准|通过|嗯|收到)/.test(txt)) {
    return { ok: false, error: '签字回话里没有同意词' };
  }

  const at = iso(now);
  const trialUntil = c.risk === 'low' ? null : addDays(30, now);
  const next = rows.map((x) => x.id === cid ? {
    ...x,
    status: trialUntil ? 'trial' : 'approved',
    trialUntil,
    verification: 'user-confirmed',
    approvedBy: { kind: 'master-raw', rawId: rid, shownRawId: shown || show.outRawId || '', at },
    updatedAt: at,
    history: [...(x.history || []), { at, event: 'approve', rawId: rid, shownRawId: shown || show.outRawId || '', trialUntil }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  appendOne(storeDir, REVIEW_LOG_FILE, {
    event: 'approve', candidateId: cid, rawId: rid, shownRawId: shown || show.outRawId || '', at, trialUntil,
  });
  return { ok: true, candidate: next.find((x) => x.id === cid) };
}

export function selfApproveCandidate({ storeDir, id, now } = {}) {
  const cid = String(id || '').trim();
  const rows = readCandidates(storeDir);
  const c = rows.find((x) => x.id === cid);
  if (!c) return { ok: false, error: `找不到候选 ${cid}` };
  if (c.kind !== 'preference' || c.risk !== 'low') {
    return { ok: false, error: '只有 low risk 的 preference 能自批；lesson/rule/fact 仍要主人签字' };
  }
  if (c.status !== 'pending') return { ok: false, error: `候选状态是 ${c.status}` };
  const at = iso(now);
  const next = rows.map((x) => x.id === cid ? {
    ...x, status: 'approved', verification: 'unverified',
    approvedBy: { kind: 'local-cli', at }, updatedAt: at,
    history: [...(x.history || []), { at, event: 'self-approve' }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  appendOne(storeDir, REVIEW_LOG_FILE, { event: 'self-approve', candidateId: cid, at });
  return { ok: true, candidate: next.find((x) => x.id === cid) };
}

export function rejectCandidate({ storeDir, id, reason = '', now } = {}) {
  const cid = String(id || '').trim();
  const rows = readCandidates(storeDir);
  const c = rows.find((x) => x.id === cid);
  if (!c) return { ok: false, error: `找不到候选 ${cid}` };
  const at = iso(now);
  const next = rows.map((x) => x.id === cid ? {
    ...x, status: 'rejected', rejectedAt: at, rejectReason: String(reason || '').slice(0, 300),
    updatedAt: at, history: [...(x.history || []), { at, event: 'reject', reason: String(reason || '') }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  appendOne(storeDir, REVIEW_LOG_FILE, { event: 'reject', candidateId: cid, reason: String(reason || ''), at });
  return { ok: true, candidate: next.find((x) => x.id === cid) };
}

export function promoteCandidate({ storeDir, id, now } = {}) {
  const cid = String(id || '').trim();
  const rows = readCandidates(storeDir);
  const c = rows.find((x) => x.id === cid);
  if (!c) return { ok: false, error: `找不到候选 ${cid}` };
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (c.status === 'trial') {
    const until = Date.parse(String(c.trialUntil || ''));
    if (!Number.isFinite(until) || nowMs < until) {
      return { ok: false, error: `还在试用期（到 ${String(c.trialUntil || '?').slice(0, 10)}），试用期内不进 facts；到期再 promote` };
    }
  } else if (c.status !== 'approved') {
    return { ok: false, error: `候选状态是 ${c.status}，先签再转正` };
  }
  if (c.risk === 'high' && !c.approvedBy) return { ok: false, error: 'high risk 没有 approvedBy，不能转正' };
  if (c.verification === 'falsified') return { ok: false, error: '已证伪的候选不能转正，留档即可' };
  if (c.kind === 'skill') return { ok: false, error: '技能只到候选 + 回执，不进记忆层；要变成操作走电脑操作那条路' };

  if (c.kind === 'lesson') {
    const v = validateLesson(c.lesson);
    if (!v.ok) return v;
    const lessons = readLessons(storeDir);
    const dup = lessons.find((l) => l && l.status !== 'archived' && l.text === c.text);
    const at = iso(now);
    let lesson;
    if (dup) {
      lesson = { ...dup, occurrences: Number(dup.occurrences || 1) + 1, updatedAt: at };
    } else {
      const lid = nextId(lessons, 'ls');
      lesson = {
        id: lid, text: c.text, lesson: c.lesson, source: c.source,
        learnedFrom: c.id, status: 'active', occurrences: 1,
        createdAt: at, updatedAt: at, reviewAt: addDays(7, now), lastUsedAt: null,
        history: [{ at, event: 'promote', from: c.id }],
      };
    }
    const idx = lessons.findIndex((l) => l.id === lesson.id);
    if (idx >= 0) lessons[idx] = lesson; else lessons.push(lesson);
    writeAll(storeDir, LESSONS_FILE, lessons);
    return finishPromote({ storeDir, rows, cid, at, promotedTo: 'lessons', promotedId: lesson.id, extra: { lesson } });
  }

  if (c.kind === 'reading') {
    const at = iso(now);
    const dir = join(storeDir, BOOKS_DIR);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'note-' + c.id + '.md');
    const body = [
      '# ' + c.text,
      '',
      '- 来源：' + c.source.kind + '｜' + (c.source.anchors || []).join(' / '),
      '- 候选：' + c.id + '（learnedFrom）',
      '- 原话/摘录：' + (c.source.quote || '（没有摘录）'),
      '- 转正时间：' + at,
      '',
    ].join('\n');
    writeFileSync(f, body, 'utf8');
    return finishPromote({ storeDir, rows, cid, at, promotedTo: 'books', promotedId: 'note-' + c.id + '.md', extra: { file: f } });
  }

  if (c.kind === 'preference') {
    const rawId = rawAnchorOf(c.source);
    if (!rawId) return { ok: false, error: 'preference 没有 rawId 锚，不能转正' };
    const raw = readRawRows(storeDir);
    const row = raw.find((r) => r.id === rawId);
    if (!row) return { ok: false, error: `preference 的 rawId ${rawId} 不在 raw-log 里` };
    const prefs = readPreferences(storeDir);
    const at = iso(now);
    const dup = prefs.find((p) => p && p.text === c.text && p.status === 'active');
    if (dup) return { ok: true, candidate: c, preference: dup, duplicate: true };
    const pref = {
      id: nextId(prefs, 'pr'), text: c.text, slot: '偏好',
      rawId, rawIds: [rawId], source: c.source,
      learnedFrom: c.id, status: 'active', createdAt: at, updatedAt: at,
    };
    appendRowsFile(storeDir, PREFERENCES_FILE, pref);
    return finishPromote({ storeDir, rows, cid, at, promotedTo: 'preferences', promotedId: pref.id, extra: { preference: pref } });
  }

  if (c.kind === 'fact' || c.kind === 'rule') {
    const rawId = rawAnchorOf(c.source);
    if (!rawId) return { ok: false, error: `${c.kind} 没有 rawId 锚，不能转正` };
    const raw = readRawRows(storeDir);
    const slot = c.kind === 'rule' ? '规矩' : (c.slot || '事实');
    const r = writeFactRow({
      storeDir,
      text: c.text,
      rawRows: raw,
      rawId,
      anchor: String(c.source.quote || '').trim(),
      slot,
      kind: c.kind === 'rule' ? '规则' : '事实',
      summary: c.text,
      learnedFrom: c.id,
      sourceNote: { file: 'learning', lines: c.id },
      answerFor: c.answerFor || null,
      onConflict: recordConflict,
    });
    if (!r.ok) return r;
    return finishPromote({
      storeDir, rows, cid, at: iso(now), promotedTo: 'facts', promotedId: r.fact.id,
      extra: { fact: r.fact, conflictNote: r.conflictNote },
    });
  }

  return { ok: false, error: `不认识的 kind「${c.kind}」` };
}

function finishPromote({ storeDir, rows, cid, at, promotedTo, promotedId, extra = {} }) {
  const next = rows.map((x) => x.id === cid ? {
    ...x, status: 'promoted', promotedTo, promotedId,
    updatedAt: at,
    history: [...(x.history || []), { at, event: 'promote', promotedTo, promotedId }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  appendOne(storeDir, REVIEW_LOG_FILE, { event: 'promote', candidateId: cid, promotedTo, promotedId, at });
  return { ok: true, candidate: next.find((x) => x.id === cid), ...extra };
}

export function sweepLearning({ storeDir, now } = {}) {
  const nowMs = new Date(now ?? Date.now()).getTime();
  const at = iso(now);
  const lessons = readLessons(storeDir);
  let changed = 0;
  const nextLessons = lessons.map((l) => {
    if (!l || ['archived'].includes(l.status)) return l;
    const review = Date.parse(String(l.reviewAt || ''));
    const used = Date.parse(String(l.lastUsedAt || l.createdAt || ''));
    let status = l.status;
    if (Number.isFinite(review) && nowMs >= review && status === 'active') status = 'review-due';
    if (status === 'review-due' && Number.isFinite(used) && nowMs - used >= 30 * DAY) status = 'stale';
    if (status === 'stale' && Number.isFinite(used) && nowMs - used >= 90 * DAY) status = 'archived';
    if (status !== l.status) { changed++; return { ...l, status, updatedAt: at }; }
    return l;
  });
  if (changed) writeAll(storeDir, LESSONS_FILE, nextLessons);

  const candidates = readCandidates(storeDir);
  let changedCandidates = 0;
  const nextCandidates = candidates.map((c) => {
    if (!c) return c;
    if (['promoted', 'rejected', 'archived'].includes(c.status)) return c;
    const created = Date.parse(String(c.createdAt || ''));
    const updated = Date.parse(String(c.updatedAt || c.createdAt || ''));
    let status = c.status;
    if (status === 'trial') {
      const until = Date.parse(String(c.trialUntil || ''));
      if (Number.isFinite(until) && nowMs >= until) {
        status = 'approved';
      }
    } else if (status === 'pending' && Number.isFinite(created) && nowMs - created >= 7 * DAY) {
      status = 'review-due';
    } else if (['pending', 'review-due', 'approved'].includes(status)
      && Number.isFinite(updated) && nowMs - updated >= 30 * DAY) {
      status = 'stale';
    }
    if (status === 'stale' && Number.isFinite(updated) && nowMs - updated >= 90 * DAY) {
      status = 'archived';
    }
    if (status !== c.status) {
      changedCandidates++;
      return { ...c, status, updatedAt: at, history: [...(c.history || []), { at, event: 'sweep', from: c.status, to: status }] };
    }
    return c;
  });
  if (changedCandidates) writeAll(storeDir, CANDIDATES_FILE, nextCandidates);
  return { ok: true, changed: changed + changedCandidates, lessons: nextLessons, candidates: nextCandidates };
}

/**
 * 失败驱动教训的受控自动转正：
 * - 只认 kind=lesson、source.kind=failure、risk=low、pending、已满 24h；
 * - 每天最多 maxPerDay 条（默认 1），有人正在看（open show）就跳过；
 * - 先写成 approved，再走同一条 promoteCandidate；失败则退回 pending，不半吞。
 * 这不是“模型自批”：候选是代码从重复缺口生成的，人没反对才放行。
 */
export function autoPromoteFailureLessons({ storeDir, now, maxPerDay = 1, minAgeHours = 24 } = {}) {
  const nowMs = new Date(now ?? Date.now()).getTime();
  const at = iso(now);
  const today = shanghaiDay(now);
  const log = readReviewLog(storeDir);
  const todayCount = log.filter((e) => e && e.event === 'auto-approve' && shanghaiDay(e.at) === today).length;
  if (todayCount >= maxPerDay) return { ok: true, promoted: 0, skipped: 'daily-cap', todayCount };
  const rows = readCandidates(storeDir);
  const due = rows
    .filter((c) => c && c.status === 'pending' && c.kind === 'lesson'
      && c.source && c.source.kind === 'failure' && c.risk === 'low')
    .filter((c) => Number.isFinite(Date.parse(String(c.createdAt || '')))
      && nowMs - Date.parse(String(c.createdAt)) >= minAgeHours * 3600000)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!due.length) return { ok: true, promoted: 0, skipped: 'none-due' };
  const c = due[0];
  if (openShow(storeDir, c.id)) return { ok: true, promoted: 0, skipped: 'open-show', candidateId: c.id };

  const next = rows.map((x) => x.id === c.id ? {
    ...x,
    status: 'approved',
    verification: 'unverified',
    approvedBy: { kind: 'auto-failure-24h', at },
    updatedAt: at,
    history: [...(x.history || []), { at, event: 'auto-approve', reason: 'failure lesson 24h 无反对' }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, next);
  appendOne(storeDir, REVIEW_LOG_FILE, { event: 'auto-approve', candidateId: c.id, at, reason: 'failure lesson 24h 无反对' });

  const p = promoteCandidate({ storeDir, id: c.id, now });
  if (p.ok) {
    return {
      ok: true, promoted: 1, candidateId: c.id,
      lesson: p.lesson || null, promotedTo: p.candidate?.promotedTo || '',
    };
  }

  // 转正失败：退回 pending，保留失败记录，下一轮还能再试。
  const cur = readCandidates(storeDir);
  const reverted = cur.map((x) => x.id === c.id ? {
    ...x, status: 'pending', approvedBy: null, updatedAt: at,
    history: [...(x.history || []), { at, event: 'auto-approve-failed', error: String(p.error || '') }],
  } : x);
  writeAll(storeDir, CANDIDATES_FILE, reverted);
  appendOne(storeDir, REVIEW_LOG_FILE, { event: 'auto-approve-failed', candidateId: c.id, at, error: String(p.error || '') });
  return { ok: false, promoted: 0, candidateId: c.id, error: p.error || 'promote failed' };
}

export function markLessonUsed({ storeDir, id, now } = {}) {
  const lessons = readLessons(storeDir);
  const at = iso(now);
  let hit = null;
  const next = lessons.map((l) => {
    if (l.id !== id) return l;
    hit = { ...l, lastUsedAt: at, updatedAt: at, status: l.status === 'review-due' ? 'active' : l.status };
    return hit;
  });
  if (!hit) return { ok: false, error: `找不到 lesson ${id}` };
  writeAll(storeDir, LESSONS_FILE, next);
  return { ok: true, lesson: hit };
}

/**
 * 失败驱动自动提炼：同一个缺口连续出现 ≥2 次，产一条 low risk 的 lesson 候选。
 * 只产候选，不转正；同 failureKey 只产一次；配额由 addCandidate 管。
 */
export function autoLessonFromFailure({ storeDir, kind = 'ask', question, conv = '', detail = '', now } = {}) {
  const q = norm(question).slice(0, 240);
  if (!q) return { ok: false, error: 'question 是空的' };
  const key = `${kind}|${q}`;
  const gaps = readGaps(storeDir);
  const gap = gaps.find((g) => g && g.key === key && g.status === 'open');
  if (!gap || Number(gap.count || 1) < 2) return { ok: false, skipped: 'need-repeat' };
  const rows = readCandidates(storeDir);
  const existed = rows.find((c) => c && c.failureKey === key);
  if (existed) return { ok: true, candidate: existed, duplicate: true };
  const text = `「${q.slice(0, 80)}」连着没答上`;
  const lesson = {
    symptom: `同一类问题连着出现：${q.slice(0, 120)}`,
    rootCause: '库里没有能指回的原话/事实，或问题超出当前覆盖范围；第一次没答上时没有停下来记缺口。',
    detour: '第一次没答上就换说法、或拿最像的一条顶上。',
    resolution: '记缺口，等主人补原话或补采集；不硬答。',
    prevention: '遇到这类问题，先记缺口并说「我查一下/查不到」，不硬答。',
    notWhen: '只是闲聊、对方没指望答案时，不必记。',
  };
  const added = addCandidate({
    storeDir, kind: 'lesson', text, lesson,
    source: { kind: 'failure', anchors: [], speaker: 'master', quote: String(gap.lastDetail || detail || '').slice(0, 300) },
    origin: kind === 'gate' ? 'gate' : kind === 'verify' ? 'verify' : 'inbound',
    risk: 'low', verification: 'unverified', failureKey: key, now,
  });
  return added;
}

export function recordGap({ storeDir, kind = 'ask', question, conv = '', result = '', detail = '', now } = {}) {
  const q = norm(question).slice(0, 240);
  if (!q) return { ok: false, error: 'question 是空的' };
  const key = `${kind}|${q}`;
  const rows = readGaps(storeDir);
  const at = iso(now);
  const hit = rows.find((g) => g && g.key === key && g.status === 'open');
  if (hit) {
    const next = rows.map((g) => g === hit ? {
      ...g, count: Number(g.count || 1) + 1, lastSeen: at, lastResult: String(result || ''),
      lastDetail: String(detail || '').slice(0, 300), conv: String(conv || g.conv || ''),
    } : g);
    writeAll(storeDir, GAPS_FILE, next);
    return { ok: true, gap: next.find((g) => g.id === hit.id), duplicate: true };
  }
  const gap = {
    id: nextId(rows, 'G'), key, kind, question: q, conv: String(conv || ''),
    count: 1, firstSeen: at, lastSeen: at, lastResult: String(result || ''),
    lastDetail: String(detail || '').slice(0, 300), status: 'open',
  };
  writeAll(storeDir, GAPS_FILE, [...rows, gap]);
  return { ok: true, gap };
}

export function closeGap({ storeDir, id, resolution = '', now } = {}) {
  const rows = readGaps(storeDir);
  const at = iso(now);
  let hit = null;
  const next = rows.map((g) => {
    if (g.id !== id) return g;
    hit = { ...g, status: 'closed', closedAt: at, resolution: String(resolution || '').slice(0, 300) };
    return hit;
  });
  if (!hit) return { ok: false, error: `找不到 gap ${id}` };
  writeAll(storeDir, GAPS_FILE, next);
  return { ok: true, gap: hit };
}

export function recordConflict({ storeDir, kind = 'fact', left = '', right = '', reason = '', now } = {}) {
  const key = `${kind}|${left}|${right}`;
  const rows = readConflicts(storeDir);
  const at = iso(now);
  const hit = rows.find((c) => c && c.key === key && c.status === 'disputed');
  if (hit) return { ok: true, conflict: hit, duplicate: true };
  const conflict = {
    id: nextId(rows, 'C'), key, kind, left: String(left), right: String(right),
    reason: String(reason || '').slice(0, 400), status: 'disputed',
    createdAt: at, resolvedAt: null, resolution: '',
  };
  writeAll(storeDir, CONFLICTS_FILE, [...rows, conflict]);
  return { ok: true, conflict };
}

export function resolveConflict({ storeDir, id, resolution = '', now } = {}) {
  const rows = readConflicts(storeDir);
  const at = iso(now);
  let hit = null;
  const next = rows.map((c) => {
    if (c.id !== id) return c;
    hit = { ...c, status: 'resolved', resolvedAt: at, resolution: String(resolution || '').slice(0, 300) };
    return hit;
  });
  if (!hit) return { ok: false, error: `找不到冲突 ${id}` };
  writeAll(storeDir, CONFLICTS_FILE, next);
  return { ok: true, conflict: hit };
}

export function learningCounts(storeDir) {
  const candidates = readCandidates(storeDir);
  const lessons = readLessons(storeDir);
  const conflicts = readConflicts(storeDir).filter((c) => c.status === 'disputed');
  const gaps = readGaps(storeDir).filter((g) => g.status === 'open');
  return {
    pending: candidates.filter((c) => c.status === 'pending').length,
    approved: candidates.filter((c) => c.status === 'approved').length,
    trial: candidates.filter((c) => c.status === 'trial').length,
    promoted: candidates.filter((c) => c.status === 'promoted').length,
    dueCandidates: candidates.filter((c) => c.status === 'review-due').length,
    dueLessons: lessons.filter((l) => l.status === 'review-due').length,
    staleLessons: lessons.filter((l) => l.status === 'stale').length,
    conflicts: conflicts.length,
    gaps: gaps.length,
  };
}

export function formatCandidate(c, { show = false } = {}) {
  if (!c) return '';
  const lines = [
    `${show ? '【待签】' : '【候选】'}${c.id}｜${c.kind}｜${c.risk}｜${c.status}｜${c.verification}`,
    c.text,
  ];
  if (c.trialUntil) lines.push(`试用到：${String(c.trialUntil).slice(0, 10)}（到期前不进 facts）`);
  if (c.lesson) {
    lines.push(`现象：${c.lesson.symptom}`);
    lines.push(`根因：${c.lesson.rootCause}`);
    lines.push(`绕路：${c.lesson.detour}`);
    lines.push(`解法：${c.lesson.resolution}`);
    lines.push(`下次：${c.lesson.prevention}`);
    lines.push(`不适用：${c.lesson.notWhen}`);
  }
  const src = c.source || {};
  lines.push(`来源：${src.kind || '?'}${src.speaker ? `（${src.speaker === 'self' ? '我' : '主人'}）` : ''}${(src.anchors || []).length ? '｜' + src.anchors.join(' / ') : ''}`);
  if (src.quote) lines.push(`原话：${src.quote}`);
  if (show) {
    lines.push('');
    lines.push('回：同意 / 可以 / 签了 / 转正（只回这一句；中间岔题作废，要签重新展示）');
  }
  return lines.join(String.fromCharCode(10));
}

export function formatCandidateList(rows, { limit = 20 } = {}) {
  if (!rows.length) return '候选账是空的。';
  return rows.slice(-Math.max(1, Math.min(50, Number(limit) || 20))).map((c) => `- ${c.id}｜${c.kind}｜${c.risk}｜${c.status}｜${c.text.slice(0, 80)}`).join(String.fromCharCode(10));
}

export function formatReview({ storeDir, now } = {}) {
  const counts = learningCounts(storeDir);
  const candidates = readCandidates(storeDir).filter((c) => ['pending', 'approved', 'trial'].includes(c.status));
  const due = readLessons(storeDir).filter((l) => ['review-due', 'stale'].includes(l.status));
  const conflicts = readConflicts(storeDir).filter((c) => c.status === 'disputed');
  const gaps = readGaps(storeDir).filter((g) => g.status === 'open');
  const lines = [
    `【学习/账本】待审 ${counts.pending}｜已签 ${counts.approved}｜试用 ${counts.trial}｜已转正 ${counts.promoted}｜候选回看 ${counts.dueCandidates}｜到期回看 ${counts.dueLessons}｜陈旧 ${counts.staleLessons}｜冲突 ${counts.conflicts}｜缺口 ${counts.gaps}`,
  ];
  if (candidates.length) {
    lines.push('待审候选：');
    for (const c of candidates.slice(-10)) lines.push(`- ${c.id}｜${c.kind}｜${c.risk}｜${c.status}｜${c.text.slice(0, 90)}`);
  }
  if (due.length) {
    lines.push('到期回看：');
    for (const l of due.slice(-10)) lines.push(`- ${l.id}｜${l.status}｜${l.text.slice(0, 90)}`);
  }
  if (conflicts.length) {
    lines.push('冲突（disputed，不覆盖）：');
    for (const c of conflicts.slice(-10)) lines.push(`- ${c.id}｜${c.left} ↔ ${c.right}｜${c.reason}`);
  }
  if (gaps.length) {
    lines.push('缺口（没答上的）：');
    for (const g of gaps.slice(-10)) lines.push(`- ${g.id}｜${g.count} 次｜${g.question.slice(0, 90)}`);
  }
  if (!candidates.length && !due.length && !conflicts.length && !gaps.length) lines.push('没有待处理的。');
  return lines.join(String.fromCharCode(10));
}
