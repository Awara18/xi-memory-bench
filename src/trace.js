/**
 * 翻账（trace）—— 叙事题的候选清单：哪天、谁说的、正文、前后文。
 *
 * 它不判「该不该答」，也不挑一条给答案（这两件都量死过，见 review/给DSH-翻账接插件-2026-11-21.md 第四节）。
 * 它只做一条管线：embedding 扫 top50 → rerank → 字二元组去重 → 取前 N → 摆出来给人读。
 * 只读：不写 raw-log、不写 facts、不碰 ask_xi / ask_raw 的判断。
 *
 * 数据：workspace/xi-memory/trace/{units.jsonl, chunks/*.f32}
 * 开关：workspace/xi-memory/trace.config.json（默认 off，写 {"on": true} 才开）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MASTER_ALT, SELF_ALT } from './identity.js';

const DIM = 1024;
const BLOCK = 500;
const MAX_TOP = 30;
const RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';

const SRC_NAME = {
  factstore: '库条目', doc: '文档', 'legacy-judgment': '旧判断', seed: '种子摘要',
  note: '笔记', tool: '工具回执', pet_say: '气泡', 'legacy-desktop': '桌面库', 'live-backfill': '回填', 'doc-file': '文档',
};

const roleOf = (sp) => {
  const s = String(sp || '');
  if (new RegExp(MASTER_ALT).test(s)) return '主人';
  if (new RegExp('^(' + SELF_ALT + ')$').test(s)) return '我';
  return `群友:${s || '不明'}`;
};

const srcTag = (u) => {
  const s = String(u.src || '');
  if (u.doc) return `【文档】${u.doc}:${u.docLine || '?'}${u.docDate ? ' · ' + u.docDate : ''} `;
  if (s === 'rawlog' || s === 'qq-sent') return '';
  return `【${SRC_NAME[s] || s || '来源不明'}】`;
};


// ---- 本子条回核原话区（11-21 20:0x，他点头）----
// 总纲第六条：每条都得能按字串指回原话那一行。本子指不回就只能是线索。
// 做法：把非本子单元的正文拼成一条大串，带上偏移，拿本子里的长片段去 indexOf。

// 能拿来核的两类：当场说的（原话区），和蒸馏出来的（事实区）。
// #doc 是旧文档导进库的副本，拿它作证等于自己证明自己，一律不收。
const RAW_SRC = new Set(['rawlog', 'qq-sent', 'live-backfill', 'live']);
const DISTILL_SRC = new Set(['factstore']);

export function buildRawHaystack(units) {
  let s = '';
  const spans = [];
  for (const u of units) {
    if (u.doc) continue;
    const src = String(u.src || '');
    if (!RAW_SRC.has(src) && !DISTILL_SRC.has(src)) continue;
    const t = String(u.text || '');
    if (!t) continue;
    spans.push({ start: s.length, end: s.length + t.length, u, rank: RAW_SRC.has(src) ? 0 : 1 });
    s += t + '\n';
  }
  return { s, spans };
}

/** 在拼好的原话串里找一条片段，返回命中的那个单元（找不到返回 null）。 */
export function findRaw(hay, probe) {
  if (!hay || !probe) return null;
  const i = hay.s.indexOf(probe);
  if (i < 0) return null;
  let lo = 0, hi = hay.spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sp = hay.spans[mid];
    if (i < sp.start) hi = mid - 1;
    else if (i >= sp.end) lo = mid + 1;
    else return { ...sp.u, rank: sp.rank };
  }
  return null;
}

/** 从本子正文里挑几段能拿去核的片段：先剥 Markdown 壳，再按标点切开，长的优先。 */
export function probesOf(text) {
  const cjk = (x) => (x.match(/[\u4e00-\u9fff]/g) || []).length;
  const clean = String(text || '')
    .replace(/[\u0060*#>~]/g, ' ')
    .replace(/^\s*[-•·]\s*/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ok = (x, min) => x.length >= min && cjk(x) >= min && cjk(x) / x.length >= 0.7 && !/[A-Za-z]{3,}/.test(x);
  // 引号里那截先收：原话最常待在这里，而且常被句内逗号切断，按标点切就废了。
  const quoted = [];
  for (const m of String(text || '').matchAll(/[「『“"']([^」』”"']{4,60})[」』”"']/g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (ok(t, 6)) quoted.push(t);
  }
  const parts = clean
    .split(/[，。；、！？：,.;!?「」『』“”‘’《》()（）\[\]]/)
    .map((x) => x.trim().replace(/^[-\d.\s]+/, '').trim())
    // 普通片段：汉字 ≥10 且占七成以上。路径、字段名、英文单词、时间戳都不是人话；
    // 第一版没挡，撞出来的命中全是假的。
    .filter((x) => ok(x, 10));
  const all = [...new Set([...quoted, ...parts])];
  all.sort((a, b) => b.length - a.length);
  return all.slice(0, 14).map((p) => (p.length > 24 ? p.slice(0, 24) : p));
}

/** 一条本子单元回核原话区：返回 {hit, probe} 或 {hit:null}。 */
export function traceBackDoc(hay, text) {
  let best = null;
  for (const probe of probesOf(text)) {
    const hit = findRaw(hay, probe);
    if (!hit) continue;
    if (!best || hit.rank < best.hit.rank) best = { hit, probe };
    if (best.hit.rank === 0) break; // 已经是原话区，不用再找了
  }
  return best || { hit: null, probe: '' };
}

/** 密钥不许进日志、回执、错误信息：错误里出现 sk- 就打掉。 */
const scrubbed = (s) => String(s == null ? '' : s).replace(/sk-[A-Za-z0-9_\-*]+/g, 'sk-***').slice(0, 200);

/** 从 botDir/.env 取一个键（只在这台机器上读，不外传、不打印）。 */
function envValue(botDir, name) {
  try {
    const p = join(botDir, '.env');
    if (!existsSync(p)) return '';
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return String(m[2] || '').trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 读不到就当没有 */ }
  return '';
}

/** 读开关与配置；env 覆盖只给探针用。 */
export function loadTraceConfig(storeDir, botDir) {
  let cfg = null;
  try {
    const p = join(storeDir, 'trace.config.json');
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, 'utf8'));
  } catch { cfg = null; }
  const onEnv = String(process.env.XI_TRACE_ON || '').trim();
  const on = onEnv ? onEnv === '1' : (cfg && cfg.on === true);
  const dir = String(process.env.XI_TRACE_DIR || (cfg && cfg.dir) || 'workspace/xi-memory/trace');
  const absDir = /^[A-Za-z]:[\\/]|^\//.test(dir)
    ? dir
    : join(botDir, ...dir.split(/[\\/]/).filter(Boolean));
  const embed = { ...((cfg && cfg.embed) || {}) };
  const rerank = { ...((cfg && cfg.rerank) || {}) };
  embed.url = embed.url || EMBED_URL;
  embed.model = embed.model || 'qwen3.7-text-embedding';
  embed.dim = Number(embed.dim || DIM);
  rerank.url = rerank.url || RERANK_URL;
  rerank.model = rerank.model || 'qwen3.7-text-rerank';
  const embedKey = String(embed.key || '') || envValue(botDir, 'XI_TRACE_EMBED_KEY') || envValue(botDir, 'QWEN_API_KEY');
  const rerankKey = String(rerank.key || '') || envValue(botDir, 'XI_TRACE_RERANK_KEY')
    || envValue(botDir, 'QWEN_RERANK_API_KEY') || embedKey;
  return {
    on, dir: absDir, embed: { ...embed, key: embedKey }, rerank: { ...rerank, key: rerankKey },
    depth: Math.max(1, Number((cfg && cfg.depth) || 50)), top: Math.max(1, Number((cfg && cfg.top) || 15)),
  };
}

// ---- 索引缓存：units.jsonl 或任一 .f32 变了就重读 ----
let cache = { dir: '', stamp: '', units: null, bufs: null };

function loadIndex(dir) {
  const unitsPath = join(dir, 'units.jsonl');
  const chunksDir = join(dir, 'chunks');
  if (!existsSync(unitsPath) || !existsSync(chunksDir)) return { err: 'no-index' };
  const files = readdirSync(chunksDir).filter((f) => f.endsWith('.f32')).sort();
  if (!files.length) return { err: 'no-index' };
  let stamp = '';
  try {
    stamp = [statSync(unitsPath).mtimeMs, ...files.map((f) => statSync(join(chunksDir, f)).mtimeMs)].join(',');
  } catch { return { err: 'no-index' }; }
  if (cache.dir === dir && cache.stamp === stamp && cache.units) return { units: cache.units, bufs: cache.bufs, files };
  const units = readFileSync(unitsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const bufs = files.map((f) => readFileSync(join(chunksDir, f)));
  cache = { dir, stamp, units, bufs };
  return { units, bufs, files };
}

const bigrams = (s) => {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
};
const jac = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  const u = a.size + b.size - n;
  return u ? n / u : 1;
};
const dedupe = (rows, limit, thr = 0.5) => {
  const kept = [], bags = [];
  for (const u of rows) {
    const bag = bigrams(u.text);
    if (bags.some((b) => jac(bag, b) > thr)) continue;
    kept.push(u); bags.push(bag);
    if (kept.length >= limit) break;
  }
  return kept;
};

// 问句里的日子：认「2026-11-19」「11 月 19 号」「11-19」「今天/昨天/前天」，认不出返回空串。
// 裸月日一律按今年算；算出来比今天还晚，就当是去年的（跨年那一问）。
function dateOfQuestion(q) {
  const now = new Date(Date.now() + 8 * 3600e3);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const todayStr = ymd(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const fix = (y, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    let out = ymd(y, m, d);
    if (out > todayStr) out = ymd(y - 1, m, d);
    return out;
  };
  let m;
  if ((m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(q))) return fix(Number(m[1]), Number(m[2]), Number(m[3]));
  const rel = { 今天: 0, 昨天: 1, 前天: 2 };
  for (const k of Object.keys(rel)) {
    if (q.includes(k)) {
      const d = new Date(now.getTime() - rel[k] * 86400e3);
      return fix(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  if ((m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(q))) return fix(now.getUTCFullYear(), Number(m[1]), Number(m[2]));
  if ((m = /(?<![\d])(\d{1,2})[-/](\d{1,2})(?![\d])/.exec(q))) return fix(now.getUTCFullYear(), Number(m[1]), Number(m[2]));
  return '';
}

async function embedOne(cfg, q, signal) {
  const r = await fetch(cfg.embed.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.embed.key}` },
    body: JSON.stringify({ model: cfg.embed.model, input: [q], dimensions: cfg.embed.dim }),
    ...(signal ? { signal } : {}),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${scrubbed(txt)}`);
  const j = JSON.parse(txt);
  const v = j && j.data && j.data[0] && j.data[0].embedding;
  if (!Array.isArray(v) || v.length !== cfg.embed.dim) throw new Error(`向量维度不对：${Array.isArray(v) ? v.length : '无'}`);
  return v;
}

async function rerank(cfg, q, rows, signal) {
  const docs = rows.map((u) => (u.ctx ? `${u.text}\n（前后文：${String(u.ctx).slice(0, 140)}）` : u.text));
  const r = await fetch(cfg.rerank.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.rerank.key}` },
    body: JSON.stringify({ model: cfg.rerank.model, input: { query: q, documents: docs }, parameters: { return_documents: false } }),
    ...(signal ? { signal } : {}),
  });
  const txt = await r.text();
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${scrubbed(txt)}`);
  const j = JSON.parse(txt);
  if (!j || !j.output || !Array.isArray(j.output.results)) throw new Error(`重拍返回不合形状：${scrubbed(txt)}`);
  return j.output.results.map((it) => ({ ...rows[it.index], rr: it.relevance_score }));
}

/**
 * 主入口。返回 {ok, 数据到, 共条, 条数, 文本} 或 {error, detail}。
 * 失败一律说失败，不许返回空表冒充「没有」。
 */
export async function askTrace({ storeDir, botDir, question, top, signal }) {
  const q = String(question == null ? '' : question).trim();
  if (!q) return { error: 'bad-question', detail: '没给问句' };
  const cfg = loadTraceConfig(storeDir, botDir);
  if (!cfg.on) {
    return { error: 'off', detail: '翻账没开（写 {"on": true} 到 workspace/xi-memory/trace.config.json 才开）' };
  }
  if (!cfg.embed.key) return { error: 'embed-failed', detail: '没有 embedding key（.env 里 QWEN_API_KEY 或 trace.config.json 的 embed.key）' };

  const idx = loadIndex(cfg.dir);
  if (idx.err) return { error: 'no-index', detail: `索引文件缺失或为空：${cfg.dir}` };
  const { units, bufs } = idx;
  if (!units.length) return { error: 'no-index', detail: 'units.jsonl 是空的' };

  // 1) 召回：全量余弦扫 top depth
  const asked = dateOfQuestion(q);
  let qv;
  try { qv = await embedOne(cfg, q, signal); } catch (e) { return { error: 'embed-failed', detail: scrubbed(e && e.message) }; }
  const dim = cfg.embed.dim;
  const scores = [];
  for (const buf of bufs) {
    const n = Math.floor(buf.length / (dim * 4));
    for (let i = 0; i < n; i++) {
      let s = 0; const base = i * dim * 4;
      for (let d = 0; d < dim; d++) s += buf.readFloatLE(base + d * 4) * qv[d];
      scores.push(s);
    }
  }
  const depth = Math.min(scores.length, Math.max(cfg.depth, top || cfg.top));
  const dayOf = (u) => String(u.docDate || u.tsLocal || '').slice(0, 10);
  let picked = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, depth).map(([, i]) => units[i]).filter(Boolean);
  let dateNote = '';
  if (asked) {
    const dayIdx = [];
    for (let i = 0; i < units.length; i++) if (dayOf(units[i]) === asked) dayIdx.push(i);
    if (!dayIdx.length) {
      dateNote = `问句里的日子认成 ${asked}：索引里那天一条都没有，下面全是不分日子的召回，别当成那天的`;
    } else {
      const want = Math.min(dayIdx.length, Math.max(20, Number(top || cfg.top) || 15));
      const dayPick = dayIdx.map((i) => [scores[i], i]).sort((a, b) => b[0] - a[0]).slice(0, want).map(([, i]) => units[i]);
      const seen = new Set(dayPick);
      picked = [...dayPick, ...picked.filter((u) => !seen.has(u))].slice(0, Math.max(depth, dayPick.length));
      dateNote = `问句里的日子认成 ${asked}：索引里那天共 ${dayIdx.length} 条，按相似度挑了 ${dayPick.length} 条并进召回`;
    }
  }
  if (!picked.length) return { error: 'no-index', detail: '召回为空（块数与 units 行数对不上？）' };

  // 2) 重拍；挂了就退回纯向量顺序，但头一行必须说实话
  let rows = null, warn = '';
  try {
    rows = await rerank(cfg, q, picked, signal);
  } catch (e) {
    warn = `重拍没跑成，这是纯向量的顺序（${scrubbed(e && e.message)}）`;
    rows = picked.map((u, i) => ({ ...u, rr: 1 - i / Math.max(1, picked.length) }));
  }

  // 2b) 认出了日子：那天的一批排前面（只重排，不删）
  if (asked) {
    const hit = rows.filter((u) => dayOf(u) === asked);
    const rest = rows.filter((u) => dayOf(u) !== asked);
    if (hit.length) rows = [...hit, ...rest];
    dateNote += `；重拍后那天还剩 ${hit.length} 条`;
  }

  // 3) 去重 → 取前 N
  const n = Math.min(MAX_TOP, Math.max(1, Number(top || cfg.top) || 15));
  const view = dedupe(rows, n);

  // 4) 头一行交代数据覆盖到哪
  const maxTs = units.reduce((m, u) => (String(u.tsLocal || '') > m ? String(u.tsLocal) : m), '');
  let mt = '';
  try { mt = new Date(statSync(join(cfg.dir, 'units.jsonl')).mtimeMs + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '); } catch { /* 无 */ }
  const head = `数据到 ${maxTs || '不明'}（${units.length} 条，索引 ${mt || '时间不明'} 建）`;
  const hay = buildRawHaystack(units);
  let lead = { hit: 0, distill: 0, lone: 0 };
  const lines = [head];
  if (warn) lines.push(warn);
  lines.push('不带方框的是当场原话；【库条目】【种子摘要】是后来记的，不是谁当场说的。【文档】是我的本子（文件:行号），一律只当线索：标「⟵ 原话」的能指回原话区，标「只在蒸馏条目里」的原话区没落这句子，标「本子独有」的两头都核不到——后两种都不许当原话引。');
  if (dateNote) lines.push(dateNote);
  view.forEach((u, i) => {
    const when = u.doc ? '' : `${u.tsLocal || '时刻不明'} `;
    const who = u.doc ? '' : roleOf(u.speaker);
    let back = '';
    if (u.doc) {
      const tb = traceBackDoc(hay, u.text);
      if (tb.hit && tb.hit.rank === 0) {
        lead.hit += 1;
        back = `  ⟵ 原话 ${tb.hit.id || '?'}（${tb.hit.tsLocal || '时刻不明'}，${tb.hit.speaker || '说话人不明'}）`;
      } else if (tb.hit) {
        lead.distill += 1;
        back = `  ⟵ 只在蒸馏条目里 ${tb.hit.id || '?'}（${tb.hit.tsLocal || '时刻不明'}，${tb.hit.speaker || '说话人不明'}），原话区没有这句`;
      } else {
        lead.lone += 1;
        back = '  ⟵ 本子独有：原话区、蒸馏条目都核不到，不许当原话引';
      }
    }
    lines.push(`${String(i + 1).padStart(2)} ${Number(u.rr || 0).toFixed(3)} ${when}${srcTag(u)}${who} ｜ ${String(u.text || '').replace(/\s+/g, ' ').slice(0, 120)}${back}`);
    if (u.ctx) lines.push(`      上下文：${String(u.ctx).replace(/\s+/g, ' ').slice(0, 140)}`);
  });
  if (!view.length) lines.push('（这一问一条候选都没翻到）');

  return {
    ok: true, 结果: 'trace', 数据到: maxTs || '', 共条: units.length, 条数: view.length,
    重拍: warn ? '没跑成' : '成了', 本子回核: `核到原话 ${lead.hit} / 只在蒸馏 ${lead.distill} / 本子独有 ${lead.lone}`, 文本: lines.join('\n'),
    rows: view.map((u) => ({ line: u.line, id: u.id, tsLocal: u.tsLocal, src: u.src, speaker: u.speaker, score: u.rr })),
  };
}
