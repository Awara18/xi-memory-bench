/**
 * gate.js —— 发话前的闸门：这句话有没有证据 / 有没有把新承诺记下来。
 *
 * 我 13:24 的原话：「比如我这条回复里要是出现『上次』『第一回』『你说过』这种词，
 * 而我这一轮压根没调过查库，就在发出去之前把我拦下来。这得插件那头有口子。」
 *
 * 这个模块就是那个口子，但判据不是「她查没查」，而是「这句有没有证据」：
 *   - 旧事断言：直接把 claim 交给 verify 核原话；有据放行，没据拦下并附差在哪。
 *   - 新承诺：认出来就先落进承诺账（带到期时间或 none），再放行；认不出才拦。
 *   - 问句、假设句、序数词、元讨论：不拦，免得重演 13:34 的误伤。
 *
 * 它只写 gate-log.jsonl 和（必要时）promises.jsonl，不改 raw-log / facts。
 * 真正挂到 qq_send 前面要由 qqbot 调 tools/xi-bridge.mjs；xi 自己拦不住发送。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { localStamp, norm, overlap } from './store.js';
import { verifyClaim, formatVerify } from './verify.js';
import { addPromise, extractPromise, readPromises } from './promises.js';

export const GATE_LOG = 'gate-log.jsonl';

const QUESTION_RE = /[?？]\s*$|(吗|呢|是不是|要不要|有没有|多少|哪一天|哪天|什么时候|谁|什么)\s*[。！!？?]?\s*$/;
const META_RE = /(闸门|闸|注入|latency|毫秒|触发词|判据|核不核|没核|bridge|xi_verify|词表|误伤|拦截|recallDraftGate|gate-log|xi_gate|刚才那条|举个例子)/;
const HYPOTHETICAL_RE = /(要是|如果|万一|假如|假设)/;
const ORDINAL_RE = /(第一次|第一回|头一回)/;
const STRONG_OLD_RE = /(?:你|你们)[^。！？]{0,6}(?:说过|讲过|提过|答应过|约好过|定过)|(?:昨天|上次|之前|上回|当时|刚才)[^。！？]{0,6}(?:你|你们)[^。！？]{0,4}(?:说的|讲的|提的|答应的|约好的)|(?:你|你们)(?:昨天|上次|之前|上回|当时|刚才)[^。！？]{0,4}(?:说的|讲的|提的|答应的|约好的)|我[^。！？]{0,4}(?:说过|答应过)|我们[^。！？]{0,4}(?:说过|约好)|(?:你|你们|我们|昨天|上次|之前|上回|当时|刚才|\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日)[^。！？]{0,8}说好的|(?:你|我们)说好(?!听|话|的|看|像|笑|玩|吃|喝|要|想|点|吧|啊|呀|哦|嘛)|上次|上回|那回|几号|记不记得|还记得|以前说|当年|之前说|你上次/;
const OLD_WEAK_RE = /(哪天|定了|定过|说好|约好)/;

export function hasOldMatter(s) {
  const hypo = HYPOTHETICAL_RE.test(s);
  // 假设句只在带着明确旧事指认时才算（「要是你上次说过…」），
  // 「如果哪天…」「万一定了…」按假设放行，不重演 13:34 的误伤。
  const strongOld = s.match(STRONG_OLD_RE);
  if (hypo && !strongOld) return { hit: false, cue: '' };
  if (strongOld) return { hit: true, cue: strongOld[0] || '旧事' };
  // 「那天」单独判：只有带过去语境才算旧事；时间从句/假设（等到那天、
  // 一到不能工作那天就全塌）不算。裸「哪天」本来就不在强词表里。
  if (/那天/.test(s)) {
    const past = /(你|我们|当时|是在|见过|聊过|说过|答应|约定|一起)/.test(s);
    const notPast = /(等到?那天|到了?那天|有(?:那么|这一)?天|干不动那天|不能工作那天|到那天|那天要是|那天如果)/.test(s);
    if (past && !notPast) return { hit: true, cue: '那天' };
  }
  // 「第一次/第一回」只有在指两个人共同经历时才算旧事；「第一次断在 13:27」是序数，放行。
  if (ORDINAL_RE.test(s) && /(你|我们|那天|当时|是在|见过|聊过|说过)/.test(s)) {
    return { hit: true, cue: (s.match(ORDINAL_RE) || [])[0] || '第一次' };
  }
  // 「哪天」多半是「someday/哪个时候」，只有后面跟着说/定/约才算断言。
  if (/(哪天|哪一天)\s*(说|定|约|答应|讲)/.test(s)) return { hit: true, cue: '哪天' };
  if (/(定了|定过|说好(?!听|话|的|看|像|笑|玩|吃|喝|要|想|点|吧|啊|呀|哦|嘛)|约好)/.test(s) && /(你|我们|他|她)/.test(s)) {
    return { hit: true, cue: (s.match(OLD_WEAK_RE) || [])[0] || '说好' };
  }
  return { hit: false, cue: '' };
}

function isQuestion(s) {
  return QUESTION_RE.test(s);
}

function findOpenPromise(storeDir, cand, draft) {
  const open = readPromises(storeDir).filter((p) => p.status === 'open');
  let best = null;
  for (const p of open) {
    const sameDue = String(p.dueAt || '') === String(cand.dueAt || '');
    const ov = overlap(draft, p.text);
    const score = ov + (sameDue ? 0.15 : 0);
    if (score >= 0.35 && (!best || score > best.score)) best = { p, score };
  }
  return best ? best.p : null;
}

async function verifyWithBudget(opts, ms = 3200) {
  const ac = new AbortController();
  let timer;
  timer = setTimeout(() => ac.abort(new Error(`核验超过 ${ms}ms`)), ms);
  try {
    return await verifyClaim({ ...opts, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, error: 'timeout', detail: `核验超过 ${ms}ms` };
    return { ok: false, error: 'verify-failed', detail: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function logGate(storeDir, rec) {
  if (rec && rec.noLog) return;
  try {
    mkdirSync(storeDir, { recursive: true });
    appendFileSync(join(storeDir, GATE_LOG), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 日志写不了也不能拦发送 */ }
}

/**
 * @param {object} o
 * @param {string} o.text 要发出去的那句
 * @param {string} [o.conv]
 * @param {boolean} [o.verify=true] 测试时可关，生产别关
 * @param {boolean} [o.autoCapture=false] 兼容旧调用；默认只判不写，承诺由 captureSent 唯一落账
 * @returns {Promise<{ok:boolean,decision:'pass'|'block'|'warn',reasons:string[],message:string,verify?:object,promiseId?:string,latencyMs:number}>}
 */
export async function gateDraft({ storeDir, botDir, text, conv = '', verify = true, autoCapture = false, log = true } = {}) {
  const started = Date.now();
  const draft = norm(text);
  const base = { at: new Date().toISOString(), conv: norm(conv), text: draft, latencyMs: 0, noLog: !log };
  if (!draft) return { ok: true, decision: 'pass', reasons: ['空'], message: '', latencyMs: 0 };
  if (draft.length > 1200) {
    return { ok: true, decision: 'warn', reasons: ['太长'], message: '【提醒】这段太长，闸门只核前 1200 字；长文里的旧事仍要自己核。', latencyMs: Date.now() - started };
  }

  if (isQuestion(draft)) {
    const out = { ok: true, decision: 'pass', reasons: ['问句不核'], message: '【放行】问句不核；要问事实用 ask_xi，要问原话用 ask_raw。', latencyMs: Date.now() - started };
    logGate(storeDir, { ...base, ...out, decision: 'pass' });
    return out;
  }
  if (META_RE.test(draft)) {
    const out = { ok: true, decision: 'pass', reasons: ['元讨论'], message: '【放行】这句在讨论闸门/规则本身，不当作断言。', latencyMs: Date.now() - started };
    logGate(storeDir, { ...base, ...out });
    return out;
  }

  const old = hasOldMatter(draft);
  let v = null;
  if (old.hit) {
    if (!verify) {
      const out = { ok: true, decision: 'warn', reasons: ['旧事断言（核验已关）'], message: `【提醒】这句有「${old.cue}」，但核验被关了；别把具体日子当真的讲。`, latencyMs: Date.now() - started };
      logGate(storeDir, { ...base, ...out, reason: old.cue });
      return out;
    }
    try {
      v = await verifyWithBudget({ storeDir, botDir, claim: draft, conv, top: 5 });
    } catch (e) {
      v = { ok: false, error: 'verify-crash', detail: (e && e.message) || String(e) };
    }
    if (!v || v.ok === false) {
      const out = {
        ok: true, decision: 'warn', reasons: ['核验服务没响应'],
        message: `【提醒】核验没跑成（${(v && (v.detail || v.error)) || '未知'}）。这句先别把具体日期/原话讲死；要么先说「我翻一下」，要么改软。`,
        verify: v || null, latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out, verifyVerdict: 'error' });
      return out;
    }
    const evIds = (v.evidence || []).map((e) => e.id).filter(Boolean);
    if (v.verdict === 'supported') {
      // 有据：放行，但继续看它是不是新承诺。
    } else if (v.verdict === 'contradicted' || v.verdict === 'superseded') {
      const out = {
        ok: false, decision: 'block', reasons: ['旧事对不上'],
        message: `【拦下】这句有「${old.cue}」，但库里对不上。\n${v.missing || ''}\n要么改口，要么先说「我记不清，翻一下」；别按原说法发。`,
        verify: v, latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out, verifyVerdict: v.verdict, evidenceIds: evIds });
      return out;
    } else if (v.checks && v.checks.promise && (v.evidence || []).length) {
      // 「我答应过…」：原话能证明她说过，不能证明现在还作数。
      // 拦一句真说过的话会重演 13:34 的误伤；改成提醒，让她自己补「现在还作不作数」。
      const ev = v.evidence[0];
      const out = {
        ok: true, decision: 'warn', reasons: ['承诺有原话，效力要另看'],
        message: `【提醒】这句有「${old.cue}」，原话对得上（${ev.date || ''} ${ev.speaker || ''}）。`
          + '但原话只证明你说过，不证明现在还作数；要断言「现在仍算」，得看承诺账/后来的说法。',
        verify: v, latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out, verifyVerdict: v.verdict, evidenceIds: evIds });
      return out;
    } else {
      const out = {
        ok: false, decision: 'block', reasons: ['旧事没据'],
        message: `【拦下】这句有「${old.cue}」，但没找到对得上的证据。\n${v.missing || ''}\n要么先 xi_verify 核一句，要么把具体日期/原话删掉、说「我记不清」。`,
        verify: v, latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out, verifyVerdict: v.verdict, evidenceIds: evIds });
      return out;
    }
  }

  // 新承诺：认出来先落账，再放行。承诺账是「她说出去的话」的入口，不是拦她说话。
  const cand = extractPromise(draft);
  if (cand) {
    const existing = findOpenPromise(storeDir, cand, draft);
    if (existing) {
      const out = {
        ok: true, decision: 'pass', reasons: ['已有承诺'],
        message: `【放行】这句对应挂着的 ${existing.id}（到期 ${existing.dueAt}）。到点没做会被 review 翻出来。`,
        promiseId: existing.id, latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out });
      return out;
    }
    if (!autoCapture) {
      const out = {
        ok: true, decision: 'pass', reasons: ['新承诺待出站落账'],
        message: `【放行】这句像承诺（${cand.dueAt === 'none' ? '没定期限' : '到期 ' + cand.dueAt}）；`
          + '发送成功后由出站采集唯一落账。自查不写账。',
        promiseCandidate: { text: cand.text, dueAt: cand.dueAt, dueKind: cand.dueKind },
        latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out });
      return out;
    }
    const added = addPromise({
      storeDir,
      text: cand.text,
      dueAt: cand.dueAt,
      dueKind: cand.dueKind,
      source: { kind: 'draft', quote: draft },
      origin: 'gate-auto',
      conv,
    });
    if (!added.ok) {
      const out = {
        ok: true, decision: 'warn', reasons: ['承诺没记成'],
        message: `【提醒】这句像承诺，但没记进承诺账：${added.error}。要么补一条，要么把「回头/明天」改成不承诺的说法。`,
        latencyMs: Date.now() - started,
      };
      logGate(storeDir, { ...base, ...out });
      return out;
    }
    const out = {
      ok: true, decision: 'pass', reasons: ['新承诺已落账'],
      message: `【放行】这句是承诺，已记进承诺账 ${added.promise.id}（${added.promise.dueAt === 'none' ? '没定期限' : '到期 ' + added.promise.dueAt}）。到点没做会被 review 翻出来。`,
      promiseId: added.promise.id, latencyMs: Date.now() - started,
    };
    logGate(storeDir, { ...base, ...out });
    return out;
  }

  if (v && v.verdict === 'supported') {
    const out = {
      ok: true, decision: 'pass', reasons: ['旧事有据'],
      message: `【放行】有据：${(v.evidence || []).slice(0, 2).map((e) => `${e.date || ''} ${e.speaker || ''}`).join('；')}。引用时带日期和说话人。`,
      verify: v, latencyMs: Date.now() - started,
    };
    logGate(storeDir, { ...base, ...out, verifyVerdict: v.verdict, evidenceIds: (v.evidence || []).map((e) => e.id).filter(Boolean) });
    return out;
  }

  const out = { ok: true, decision: 'pass', reasons: [], message: '', latencyMs: Date.now() - started };
  logGate(storeDir, { ...base, ...out });
  return out;
}

export function formatGate(r) {
  if (!r) return '【闸门】没结果';
  const head = r.decision === 'block' ? '⛔ 拦下' : r.decision === 'warn' ? '⚠ 提醒' : '✓ 放行';
  const lines = [`${head}（${r.latencyMs}ms）`];
  if (r.message) lines.push(r.message);
  if (r.verify && r.verify.ok !== false) {
    lines.push('—— 核验 ——');
    lines.push(formatVerify(r.verify));
  }
  return lines.join('\n');
}
