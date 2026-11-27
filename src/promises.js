/**
 * promises.js —— 承诺账：她说出去的「什么时候做什么」，和关闭它所需的凭据。
 *
 * 为什么另起一本，不塞进 facts.jsonl：
 *   facts 的判据是「有出处、能指回原话」；承诺是未来时，写的时候还没有出处。
 *   塞进 facts 会把 ask_xi 的拒答语义搅浑（我 18:00 原话：「xi 那 144 条一半是摘要，
 *   往里面塞承诺会把它的拒答搅浑」）。
 *
 * 三条硬规矩：
 *   1. 承诺必须带 dueAt；真没有截止时间写 "none"，不许空着。
 *   2. 关闭必须有凭据：文件（且承诺之后改过）、URL、工具回执、原话行号。
 *      手写一句「做完了」不算。
 *   3. 卡片是改写过的记忆，不是原话；要断言旧事仍得走 verify 的原话层。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { daysBetween, localStamp, norm, readJsonl, readRawRows, todayLocal } from './store.js';

export const PROMISES_FILE = 'promises.jsonl';
export const GATE_LOG_FILE = 'gate-log.jsonl';


const STATUS = new Set(['open', 'done', 'dropped', 'superseded']);
const EVIDENCE_KINDS = new Set(['file', 'url', 'tool', 'quote']);

export function promisesPath(storeDir) {
  return join(storeDir, PROMISES_FILE);
}

export function readPromises(storeDir) {
  return readJsonl(promisesPath(storeDir)).filter((p) => p && p.id);
}

export function writePromises(storeDir, rows) {
  mkdirSync(storeDir, { recursive: true });
  const file = promisesPath(storeDir);
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, rows.map((p) => JSON.stringify(p)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  renameSync(tmp, file);
}

function nextId(rows) {
  let max = 0;
  for (const p of rows) {
    const n = Number(String(p.id || '').replace(/\D/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return 'p' + String(max + 1).padStart(4, '0');
}

function nowIso() {
  return new Date().toISOString();
}

function shanghaiToday(now = new Date()) {
  return todayLocal(now);
}

function addDays(dateStr, n) {
  const d = new Date(String(dateStr) + 'T00:00:00+08:00');
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function lastDayOfMonth(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00+08:00');
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  next.setDate(0);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(next);
}

function weekday(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00+08:00');
  return d.getDay(); // 0=Sun
}

/** 真日期校验：2026-02-30 / 13 月 / 32 号都不算。 */
function validDate(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return false;
  if (yy < 1900 || yy > 2200 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  return dt.getUTCFullYear() === yy && dt.getUTCMonth() === mm - 1 && dt.getUTCDate() === dd;
}

/**
 * 把「明天 / 今晚 / 下周 / 月底 / 三天后 / 2026-11-23」解成日期。
 * 只到日，不到分钟；要精确到点的提醒交给闹钟/agenda。
 */
export function parseDueInput(input, now = new Date()) {
  const raw = norm(input);
  if (!raw) return { ok: false, error: 'dueAt 是空的；没有截止时间就写 none' };
  if (/^(none|无|没有|不定|待定)$/i.test(raw)) return { ok: true, dueAt: 'none', dueKind: 'none', dueRaw: raw };

  const today = shanghaiToday(now);
  let m;
  if ((m = raw.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/))) {
    if (!validDate(m[1], m[2], m[3])) return { ok: false, error: `${raw} 不是有效日期（2 月 30 日这种不算）` };
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return { ok: true, dueAt: d, dueKind: 'date', dueRaw: raw };
  }
  if ((m = raw.match(/^(\d{1,2})-(\d{1,2})$/))) {
    const y = now.getFullYear();
    if (!validDate(y, m[1], m[2])) return { ok: false, error: `${raw} 不是有效日期` };
    return { ok: true, dueAt: `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, dueKind: 'date', dueRaw: raw };
  }
  if ((m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/))) {
    const y = now.getFullYear();
    if (!validDate(y, m[1], m[2])) return { ok: false, error: `${raw} 不是有效日期` };
    return { ok: true, dueAt: `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, dueKind: 'date', dueRaw: raw };
  }
  if (/今天/.test(raw)) return { ok: true, dueAt: today, dueKind: 'date', dueRaw: raw };
  if (/明天|明早|明晚/.test(raw)) return { ok: true, dueAt: addDays(today, 1), dueKind: 'date', dueRaw: raw };
  if (/后天/.test(raw)) return { ok: true, dueAt: addDays(today, 2), dueKind: 'date', dueRaw: raw };
  if (/大后天/.test(raw)) return { ok: true, dueAt: addDays(today, 3), dueKind: 'date', dueRaw: raw };
  if (/今晚|今天晚上/.test(raw)) return { ok: true, dueAt: today, dueKind: 'date', dueRaw: raw };
  if (/周末/.test(raw)) {
    const wd = weekday(today);
    const n = wd === 6 ? 0 : (6 - wd + 7) % 7;
    return { ok: true, dueAt: addDays(today, n), dueKind: 'date', dueRaw: raw };
  }
  if ((m = raw.match(/下周([一二三四五六日天])/))) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[m[1]];
    const wd = weekday(today);
    const nextMonday = (8 - wd) % 7 || 7;
    const delta = nextMonday + (target === 0 ? 6 : target - 1);
    return { ok: true, dueAt: addDays(today, delta), dueKind: 'date', dueRaw: raw };
  }
  if (/下周/.test(raw)) return { ok: true, dueAt: addDays(today, (8 - weekday(today)) % 7 || 7), dueKind: 'date', dueRaw: raw };
  if (/月底/.test(raw)) return { ok: true, dueAt: lastDayOfMonth(today), dueKind: 'date', dueRaw: raw };
  if (/下个?月/.test(raw)) return { ok: true, dueAt: addDays(lastDayOfMonth(today), 1), dueKind: 'date', dueRaw: raw };
  if ((m = raw.match(/([一二三四五六七八九十两\d]+)\s*天\s*后/))) {
    const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : cn[m[1]];
    if (n) return { ok: true, dueAt: addDays(today, n), dueKind: 'date', dueRaw: raw };
  }
  if ((m = raw.match(/(\d+)\s*周\s*后/))) return { ok: true, dueAt: addDays(today, Number(m[1]) * 7), dueKind: 'date', dueRaw: raw };
  if (/一周后/.test(raw)) return { ok: true, dueAt: addDays(today, 7), dueKind: 'date', dueRaw: raw };
  if (/两周后/.test(raw)) return { ok: true, dueAt: addDays(today, 14), dueKind: 'date', dueRaw: raw };
  if (/回头|之后|改天|下次|过几天|找时间/.test(raw)) return { ok: true, dueAt: 'none', dueKind: 'none', dueRaw: raw };

  return { ok: false, error: `认不出到期时间「${raw}」；给 YYYY-MM-DD，或 none` };
}

const FUTURE_RE = /(明天|明早|明晚|今晚|今天晚|待会儿|回头|下次|下周|下个?月|之后|改天|过几天|周末|月底|三天后|一周后|两周后|下午|晚上)/;
const ACTION_RE = /(去|做|写|查|改|看|发|存|整理|跑|试|修|建|备份|读|翻|问|告诉|给|弄|搞|确认|复核|对账|更新|补|删|装|换|买|找|记|录|拍|画|学|练)/;
const CUE_RE = /(答应(?!过)|约好|说好|保证|发誓|约定|我会|我去|我写|我查|我改|我看|我发|我存|我整理|我跑|我试|我修|我建|我备份)/;

/**
 * 从一句出站话里认「新承诺」。保守：
 *   - 问句不认；转述别人不认；过去时报告不认；
 *   - 要有时态词或承诺动词，且要有动作词。
 * 认不出就返回 null，不硬抓。
 */
export function extractPromise(text) {
  const s = norm(text);
  if (!s || s.length > 400) return null;
  if (/[?？]\s*$/.test(s) || /(吗|呢|是不是|要不要|有没有)\s*[。！!]?\s*$/.test(s)) return null;
  if (/(他说|她说|主人说|他答应|她答应|他讲过|她讲过)/.test(s)) return null;
  if (/(昨天|前天|上次|之前|已经|早就).{0,16}(答应|约好|说好|保证|承诺|发誓|约定)/.test(s)) return null;
  // 事后叙述已经发生的事：到点响了、按约定回了——不是新承诺。
  if (/(按约定|按说好|照约定).{0,20}(回|说|做|发|去|给)/.test(s) && !FUTURE_RE.test(s)) return null;
  if (/(到点|响了|叫了我|已经响)/.test(s) && /(了|过)/.test(s) && !FUTURE_RE.test(s)) return null;

  // 只取带承诺动词/时间词的那一句，别把整段长文塞进来。
  const sentences = s.split(/(?<=[。！？!?；;])/).map((x) => x.trim()).filter(Boolean);
  const picked = sentences.find((x) => CUE_RE.test(x) || FUTURE_RE.test(x)) || s;
  if (!picked) return null;
  // 承诺得是“我/咱”开头，或时间词开头；叙述里的“所以/但是/刚说完…”不算。
  if (!/^(我|咱|咱们|我们|明天|明早|明晚|今晚|今天晚|待会儿|回头|下次|下周|下个?月|周末|月底|之后|改天|过几天|三天后|一周后|两周后|下午|晚上|答应|约好|说好|保证|发誓|约定)/.test(picked)) {
    return null;
  }
  // 必须是我/咱自己的承诺；只有时间词的旁白不算。
  if (!/(我|咱)/.test(picked)) return null;
  // 建议/假设/猜测/回顾旧事，都不是此刻的新承诺。
  if (/(建议|可以|要不要|如果|要是|万一|可能|也许|大概|估计|好像|觉得|已经|昨天|前天|上次|之前|早就)/.test(picked)
    && !/(答应|约好|说好|保证|承诺|发誓|约定)/.test(picked)) {
    return null;
  }
  // 句子里带否定/放弃，且不是明确承诺动词，就别当承诺。
  if (/(不|别|没|不用|不必|懒得|算了)/.test(picked)
    && !/(答应|约好|说好|保证|承诺|发誓|约定)/.test(picked)) {
    return null;
  }

  const future = picked.match(FUTURE_RE);
  const action = ACTION_RE.test(picked);
  const cue = picked.match(CUE_RE);
  if (!cue && !(future && action)) return null;
  if (!future && !/(答应(?!过)|约好|说好|保证|我承诺|发誓|约定)/.test(picked)) return null;
  // 「我答应过…」多半是在报告旧事，不是此刻新承诺；带未来时间词才收。
  if (!future && /(答应过|约好过|说好过)/.test(picked)) return null;

  const dueRaw = future ? future[0] : 'none';
  const due = parseDueInput(dueRaw);
  const dueAt = due.ok ? due.dueAt : 'none';
  const dueKind = due.ok ? due.dueKind : 'none';

  return {
    text: norm(picked).slice(0, 240),
    dueAt,
    dueKind,
    dueRaw,
    cue: cue ? cue[0] : dueRaw,
    confidence: cue && future ? 0.9 : cue ? 0.7 : 0.55,
  };
}

function workspaceDirOf(storeDir) {
  return dirname(storeDir);
}

function resolveEvidencePath(storeDir, p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (isAbsolute(raw)) return raw;
  return resolve(workspaceDirOf(storeDir), raw);
}

/**
 * 关闭凭据。返回 { ok, items, errors }；有任何一条不合格，整次关闭都拒绝。
 * file 必须存在，且 mtime 晚于承诺建立时间（允许 5 分钟时钟误差）；
 * quote 必须指到 raw-log 里真实存在的行。
 */
export function validateEvidence(storeDir, promise, evidence) {
  const list = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);
  const items = [];
  const errors = [];
  if (!list.length) errors.push('没有凭据：至少给文件 / URL / 工具回执 / 原话行号之一');

  for (const e of list) {
    if (!e || typeof e !== 'object') { errors.push('凭据格式不对，要对象'); continue; }
    const kind = String(e.kind || '').trim();
    if (!EVIDENCE_KINDS.has(kind)) {
      errors.push(`凭据种类「${kind || '空'}」不算：只收 file / url / tool / quote`);
      continue;
    }
    if (kind === 'file') {
      const abs = resolveEvidencePath(storeDir, e.path || e.file);
      if (!abs) { errors.push('file 凭据缺 path'); continue; }
      if (!existsSync(abs)) { errors.push(`文件不存在：${abs}`); continue; }
      let st;
      try { st = statSync(abs); } catch { errors.push(`文件读不到：${abs}`); continue; }
      const made = Date.parse(String(promise.madeAt || ''));
      if (Number.isFinite(made) && st.mtimeMs < made - 5 * 60 * 1000) {
        errors.push(`文件在承诺之前就没再改过（mtime ${localStamp(st.mtimeMs)}），不算这次的凭据：${abs}`);
        continue;
      }
      items.push({ kind: 'file', path: abs, mtime: localStamp(st.mtimeMs), size: st.size, note: norm(e.note).slice(0, 160) });
    } else if (kind === 'url') {
      try {
        const u = new URL(String(e.url || ''));
        if (!/^https?:$/.test(u.protocol)) throw new Error('只收 http/https');
        items.push({ kind: 'url', url: u.toString(), note: norm(e.note).slice(0, 160), reachable: false });
      } catch (err) {
        errors.push(`URL 不合格：${(err && err.message) || e.url}`);
      }
    } else if (kind === 'tool') {
      const name = norm(e.name);
      const receipt = norm(e.receipt);
      if (!name || !receipt) { errors.push('tool 凭据要 name + receipt'); continue; }
      items.push({ kind: 'tool', name: name.slice(0, 80), receipt: receipt.slice(0, 300), note: norm(e.note).slice(0, 160) });
    } else if (kind === 'quote') {
      const rawId = norm(e.rawId || e.id);
      if (!rawId) { errors.push('quote 凭据要 rawId'); continue; }
      const rows = readRawRows(storeDir);
      const row = rows.find((r) => String(r.id || '') === rawId);
      if (!row) { errors.push(`原话行不存在：${rawId}`); continue; }
      if (e.quote && !norm(row.text).includes(norm(e.quote))) {
        errors.push(`引文不在 ${rawId} 的正文里`);
        continue;
      }
      items.push({
        kind: 'quote', rawId, line: row._line, date: localStamp(row.ts || row.tsUtc),
        speaker: norm((row.speaker && row.speaker.name) || ''), excerpt: norm(row.text).slice(0, 120),
      });
    }
  }

  return { ok: errors.length === 0, items, errors };
}

/**
 * 同一件事只占一张卡：写入时按「事件标签 + 同 due + 同会话」判。
 * 只认几类硬标签，不做泛语义相似，免得把两件不同的事并成一件。
 */
export function promiseTags(text) {
  const t = norm(text);
  const tags = new Set();
  if (/今晚|今天晚上/.test(t)) tags.add('tonight');
  if (/(不|别|没|不用|不会).{0,8}(动|碰|改|写|敲).{0,6}代码/.test(t)
    || /(不|别|没).{0,4}(动|碰|改|写)代码/.test(t)) tags.add('no-code');
  if (/(不|别|没|不用).{0,8}(碰|动|改).{0,6}召回/.test(t)) tags.add('no-recall');
  if (/(题单|标准答案|题目|道题|\d+\s*道|召回)/.test(t)) tags.add('question-list');
  return tags;
}

export function samePromiseEvent(a, b) {
  if (String(a && a.dueAt || '') !== String(b && b.dueAt || '')) return false;
  if (String(a && a.conv || '') !== String(b && b.conv || '')) return false;
  if (norm(a && a.text) === norm(b && b.text)) return true;
  const A = promiseTags(a && a.text);
  const B = promiseTags(b && b.text);
  const inter = [...A].filter((x) => B.has(x));
  if (inter.length >= 2) return true;
  return A.has('no-code') && B.has('no-code') && A.has('question-list') && B.has('question-list');
}

function mergeInto(keep, { text, source, origin, at }) {
  const now = at || nowIso();
  const rid = source && source.rawId ? String(source.rawId) : '';
  const before = [
    ...(Array.isArray(keep.anchorRawIds) ? keep.anchorRawIds : []),
    ...(keep.source && keep.source.rawId ? [String(keep.source.rawId)] : []),
  ];
  const had = Boolean(rid && before.includes(rid));
  const anchors = [...before, ...(rid ? [rid] : [])];
  if (anchors.length) keep.anchorRawIds = [...new Set(anchors)];
  // 同一句原话只算一次；gate 自查、qqbot 桥、出站采集重复撞到同一张卡时不加 occurrences。
  if (had) {
    keep.updatedAt = now;
    return { promise: keep, duplicate: true };
  }
  const n = Number(keep.occurrences);
  keep.occurrences = (Number.isFinite(n) && n > 0 ? n : 1) + 1;
  keep.history = [...(keep.history || []), {
    at: now,
    action: 'merge',
    note: origin || 'manual',
    text: norm(text).slice(0, 240),
    source: source && typeof source === 'object' ? source : null,
  }];
  keep.updatedAt = now;
  return { promise: keep, duplicate: false };
}

export function addPromise({ storeDir, text, dueAt, source, why, origin, conv, madeAt }) {
  const t = norm(text);
  if (!t) return { ok: false, error: 'text 是空的' };
  if (t.length > 500) return { ok: false, error: 'text 太长（>500 字），先拆成一条具体的' };
  const due = parseDueInput(dueAt);
  if (!due.ok) return { ok: false, error: due.error };

  const rows = readPromises(storeDir);
  const twin = rows.find((p) => p.status === 'open'
    && samePromiseEvent(p, { text: t, dueAt: due.dueAt, conv: norm(conv).slice(0, 80) }));
  if (twin) {
    const m = mergeInto(twin, { text: t, source, origin, at: nowIso() });
    writePromises(storeDir, rows);
    return { ok: true, promise: twin, merged: true, duplicate: Boolean(m.duplicate) };
  }

  const now = nowIso();
  const p = {
    id: nextId(rows),
    text: t,
    why: norm(why).slice(0, 240),
    source: source && typeof source === 'object' ? source : { kind: 'manual' },
    status: 'open',
    madeAt: madeAt || now,
    dueAt: due.dueAt,
    dueKind: due.dueKind,
    dueRaw: due.dueRaw,
    origin: origin || 'manual',
    conv: norm(conv).slice(0, 80),
    createdAt: now,
    updatedAt: now,
    closedAt: '',
    closeEvidence: [],
    closes: '',
    lastNudgedAt: '',
    nudgeCount: 0,
    occurrences: 1,
    history: [{ at: now, action: 'add', note: origin || 'manual' }],
  };
  rows.push(p);
  writePromises(storeDir, rows);
  return { ok: true, promise: p };
}

export function findPromise(storeDir, id) {
  return readPromises(storeDir).find((p) => String(p.id) === String(id)) || null;
}

/**
 * 存量合卡：按写入时同一套事件键，把 open 里同事件的并成一张。
 * 默认 dry-run；--apply 才写。被并的卡标 superseded，原说法进 history，不删。
 */
export function dedupePromises({ storeDir, apply = false, at } = {}) {
  const rows = readPromises(storeDir);
  const open = rows.filter((p) => p.status === 'open');
  const used = new Set();
  const groups = [];
  for (const p of open) {
    if (used.has(p.id)) continue;
    const group = [p];
    used.add(p.id);
    for (const q of open) {
      if (used.has(q.id)) continue;
      if (samePromiseEvent(p, q)) { group.push(q); used.add(q.id); }
    }
    if (group.length > 1) groups.push(group);
  }
  const now = at || nowIso();
  for (const group of groups) {
    const [keep, ...dups] = group;
    let occ = Number(keep.occurrences) || 1;
    for (const d of dups) {
      occ += Number(d.occurrences) || 1;
      keep.history = [...(keep.history || []), {
        at: now, action: 'merge', from: d.id, text: d.text, source: d.source || null,
      }];
      keep.mergedFrom = [...(keep.mergedFrom || []), d.id];
      d.status = 'superseded';
      d.supersededBy = keep.id;
      d.closedAt = now;
      d.updatedAt = now;
      d.history = [...(d.history || []), { at: now, action: 'merge-into', to: keep.id }];
    }
    keep.occurrences = occ;
    keep.updatedAt = now;
  }
  if (apply && groups.length) writePromises(storeDir, rows);
  return {
    ok: true,
    applied: !!apply,
    groups: groups.map((g) => g.map((p) => p.id)),
    merged: groups.reduce((n, g) => n + g.length - 1, 0),
  };
}

export function closePromise({ storeDir, id, evidence, note }) {
  const rows = readPromises(storeDir);
  const p = rows.find((x) => String(x.id) === String(id));
  if (!p) return { ok: false, error: `没有这条承诺：${id}` };
  if (p.status !== 'open') return { ok: false, error: `${id} 现在是「${p.status}」，不是 open` };

  const v = validateEvidence(storeDir, p, evidence);
  if (!v.ok) return { ok: false, error: '凭据不够，没关：' + v.errors.join('；'), errors: v.errors };

  const now = nowIso();
  p.status = 'done';
  p.closedAt = now;
  p.updatedAt = now;
  p.closeEvidence = v.items;
  p.closeNote = norm(note).slice(0, 240);
  p.history = [...(p.history || []), { at: now, action: 'close', evidence: v.items.map((x) => x.kind), note: p.closeNote }];
  writePromises(storeDir, rows);
  return { ok: true, promise: p, evidence: v.items };
}

export function dropPromise({ storeDir, id, reason }) {
  const rows = readPromises(storeDir);
  const p = rows.find((x) => String(x.id) === String(id));
  if (!p) return { ok: false, error: `没有这条承诺：${id}` };
  if (p.status !== 'open') return { ok: false, error: `${id} 现在是「${p.status}」，不是 open` };
  const r = norm(reason);
  if (r.length < 4) return { ok: false, error: '放弃要写理由（至少 4 个字）：为什么这条不算了' };
  const now = nowIso();
  p.status = 'dropped';
  p.closedAt = now;
  p.updatedAt = now;
  p.dropReason = r;
  p.history = [...(p.history || []), { at: now, action: 'drop', reason: r }];
  writePromises(storeDir, rows);
  return { ok: true, promise: p };
}

// 自动清理「误抓成承诺」的自述：只认 auto-outbound、没期限、带自述标记、
// 且没有未来承诺词/承诺词。默认 dry-run；apply 才写。
const AUTO_FUTURE_RE = /(明天|明早|明晚|今晚|待会儿|回头|下次|下周|下个?月|之后|改天|过几天|周末|月底|三天后|一周后|两周后)/;
const SELF_NARRATIVE_RE = /(其实|觉得|怕|本子|读了|想着|这话|那句|心里|后来|刚才)/;

export function autoDropFalseCaptures({ storeDir, apply = false, ids = null, now = nowIso() } = {}) {
  const rows = readPromises(storeDir);
  const dropped = [];
  for (const p of rows) {
    if (p.status !== 'open') continue;
    if (p.origin !== 'auto-outbound') continue;
    if (p.dueAt !== 'none') continue;
    if (ids && !ids.includes(p.id)) continue;
    const text = String(p.text || '');
    if (AUTO_FUTURE_RE.test(text) || CUE_RE.test(text)) continue;
    if (!SELF_NARRATIVE_RE.test(text)) continue;
    const reason = 'auto-false-capture: 自述/过去时，无未来时间或承诺词';
    p.status = 'dropped';
    p.closedAt = now;
    p.updatedAt = now;
    p.dropReason = reason;
    p.autoDropped = true;
    p.history = [...(p.history || []), { at: now, action: 'auto-drop', reason }];
    dropped.push({ id: p.id, text: p.text });
  }
  if (apply && dropped.length) writePromises(storeDir, rows);
  return { ok: true, applied: Boolean(apply), dropped };
}


function dueRank(p) {
  if (p.dueAt === 'none') return '9999-12-31';
  return String(p.dueAt || '9999-12-31');
}

export function listPromises(storeDir, { status = 'open', dueOnly = false, limit = 20 } = {}) {
  const rows = readPromises(storeDir);
  const today = shanghaiToday();
  let picked = rows.filter((p) => !status || p.status === status);
  if (dueOnly) picked = picked.filter((p) => p.dueAt !== 'none' && String(p.dueAt) <= today);
  picked.sort((a, b) => dueRank(a).localeCompare(dueRank(b)) || String(a.madeAt).localeCompare(String(b.madeAt)));
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  return picked.slice(0, n).map((p) => ({
    ...p,
    late: p.dueAt !== 'none' && p.dueAt ? daysBetween(p.dueAt, today) : null,
    dueToday: p.dueAt === today,
    ageDays: daysBetween(String(p.madeAt || '').slice(0, 10), today),
  }));
}

export function reviewPromises(storeDir, { limit = 12 } = {}) {
  const all = readPromises(storeDir);
  const today = shanghaiToday();
  const open = all.filter((p) => p.status === 'open');
  const overdue = open.filter((p) => p.dueAt !== 'none' && p.dueAt && String(p.dueAt) < today)
    .map((p) => ({ ...p, late: daysBetween(p.dueAt, today) }))
    .sort((a, b) => (b.late || 0) - (a.late || 0));
  const dueToday = open.filter((p) => p.dueAt === today);
  const stale = open.filter((p) => {
    const age = daysBetween(String(p.madeAt || '').slice(0, 10), today);
    return Number.isFinite(age) && age >= 7;
  }).map((p) => ({ ...p, ageDays: daysBetween(String(p.madeAt || '').slice(0, 10), today) }));
  const recentDone = all.filter((p) => p.status === 'done' && p.closedAt)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, Math.max(1, Math.min(20, Number(limit) || 12)));

  let gate = { total: 0, block: 0, warn: 0, pass: 0, byDay: {} };
  try {
    const lines = readFileSync(join(storeDir, GATE_LOG_FILE), 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let g; try { g = JSON.parse(line); } catch { continue; }
      const d = String(g.at || '').slice(0, 10);
      if (d !== today) continue;
      gate.total++;
      if (g.decision === 'block') gate.block++;
      else if (g.decision === 'warn') gate.warn++;
      else gate.pass++;
      gate.byDay[d] = (gate.byDay[d] || 0) + 1;
    }
  } catch { /* 还没 gate 日志 */ }

  return {
    ok: true,
    asOf: localStamp(new Date().toISOString()),
    today,
    counts: { open: open.length, overdue: overdue.length, dueToday: dueToday.length, stale: stale.length, done: all.filter((p) => p.status === 'done').length, dropped: all.filter((p) => p.status === 'dropped').length },
    overdue: overdue.slice(0, limit),
    dueToday: dueToday.slice(0, limit),
    stale: stale.slice(0, limit),
    recentDone,
    gate,
    note: '只读复核：到期/逾期/悬空分开列；关闭凭据在 closeEvidence 里，没凭据的 done 不算数。',
    method: 'promise-review-v1',
  };
}

export function formatPromise(p) {
  if (!p) return '（没有这条）';
  const late = p.late != null && p.late > 0 ? `，晚 ${p.late} 天` : p.dueToday ? '，今天到期' : '';
  const due = p.dueAt === 'none' ? '没定期限' : `到期 ${p.dueAt}${late}`;
  const src = p.source && p.source.kind ? `；源 ${p.source.kind}${p.source.rawId ? ' ' + p.source.rawId : ''}` : '';
  return `- ${p.id}｜${due}｜${p.status}｜${p.text}${src}`;
}

export function formatPromiseList(rows, title = '承诺') {
  if (!rows.length) return `【${title}】没有。`;
  return `【${title}】${rows.length} 条\n` + rows.map(formatPromise).join('\n');
}

export function formatReview(r) {
  if (!r || r.ok === false) return `【复核失败】${(r && r.error) || '未知错误'}`;
  const lines = [`【复核】今天 ${r.today}；挂着 ${r.counts.open} 条（逾期 ${r.counts.overdue}、今天到期 ${r.counts.dueToday}、悬空 ≥7 天 ${r.counts.stale}）`];
  if (r.overdue.length) {
    lines.push('逾期：');
    for (const p of r.overdue) lines.push(`- ${p.id}｜晚 ${p.late} 天｜${p.text}`);
  }
  if (r.dueToday.length) {
    lines.push('今天到期：');
    for (const p of r.dueToday) lines.push(`- ${p.id}｜${p.text}`);
  }
  if (r.stale.length) {
    lines.push('悬空太久（≥7 天，没定日子或一直没动）：');
    for (const p of r.stale) lines.push(`- ${p.id}｜${p.ageDays} 天｜${p.text}`);
  }
  lines.push(`今天闸门：过 ${r.gate.pass} / 拦 ${r.gate.block} / 提醒 ${r.gate.warn}`);
  if (r.recentDone.length) {
    lines.push('最近关掉的：');
    for (const p of r.recentDone) {
      const ev = (p.closeEvidence || []).map((e) => e.kind === 'file' ? `file:${e.path}` : e.kind === 'url' ? `url:${e.url}` : e.kind === 'tool' ? `tool:${e.name}` : `quote:${e.rawId}`).join('、');
      lines.push(`- ${p.id}｜${p.text}｜凭据 ${ev || '（无）'}`);
    }
  }
  lines.push(r.note);
  return lines.join('\n');
}
