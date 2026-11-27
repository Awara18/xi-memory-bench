/**
 * verify.js —— 只读校验：一句要说出去的话，库里有没有对得上的证据。
 *
 * 2026-11-22 18:0x 我定的第一步：不碰发送、不改 qqbot，先把「这句有没有证据」跑通。
 * 她原话：「现在没有任何地方能在话发出去之前把话拦住……先照文档顺序做第一步：
 * 只读的 verify 和 recap。」（17:59–18:00 聊天）
 *
 * 18:2x 又和她 lab 里的原型对了十句，补了三处：
 *   - facts.jsonl 也进证据层：摘要/属性/问法能撑住转述，不再只靠 raw-log 字面；
 *   - 四个出口：supported / contradicted / superseded / unknown；
 *   - 日期冲突优先判反；被 supersededBy 换掉的条判「换了」；
 *   - 承诺类（答应/约好/说好）没有承诺记录时，不拿一句原话硬撑成 supported。
 *
 * 证据分两层：
 *   fact  = facts.jsonl 里的条（有 id、状态、可带锚）；锚不成立时只当线索，并明说。
 *   raw   = raw-log / qq-sent 的原话行；这一层才是「她当时到底怎么说的」。
 *
 * v1 不做语义蕴含，不替她写句子——她仍要自己决定怎么说。
 */
import { askTrace } from './trace.js';
import { localStamp, norm, overlap, readFacts, readRawRows, stripPunct } from './store.js';
import { MASTER_ID, MASTER_ALT, SELF_ID, SELF_ALT, idAlt } from './identity.js';

const RAW_SRC = new Set(['rawlog', 'qq-sent', 'live', 'live-backfill']);
const METHOD = 'retrieval-consistency-v2';
const FACT_MIN = 0.5;
const PROMISE_RE = /(答应|约好|说好|保证|承诺|发誓|约定)/;

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNum(s) {
  const t = String(s || '').trim();
  if (!t) return 0;
  if (t === '十') return 10;
  if (t.startsWith('十')) return 10 + (CN_DIGIT[t.slice(1)] || 0);
  if (t.includes('十')) {
    const [a, b] = t.split('十');
    return (a ? CN_DIGIT[a] || 0 : 1) * 10 + (b ? CN_DIGIT[b] || 0 : 0);
  }
  return CN_DIGIT[t] || 0;
}

const NUM_UNITS = ['小时', '分钟', '条', '次', '个', '天', '周', '岁', '遍', '页', '行', '层', '级', '倍', '折', '成', '人', '件', '句', '段', '篇', '本', '张', '首', '部', '集', '期', '场', '元', '块', '秒'];
const NUM_RE = new RegExp(`(\d{1,4}|[零〇一二两三四五六七八九十百千]{1,6})\s*(${NUM_UNITS.join('|')})`, 'g');

/** 抽出「数字+单位」，中文数字也换算。日期/钟点不在单位表里，不会误收。 */
function numbersIn(text) {
  const out = [];
  const s = String(text || '');
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : cnNum(m[1]);
    if (Number.isFinite(n)) out.push({ n, unit: m[2], raw: m[0] });
  }
  return out;
}

/** 抽出所有绝对日期：2026-11-06 / 11-06 / 11月6日 / 6号 / 三月十四。相对日期不换算。 */
function extractDates(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (mo, d, raw) => {
    if (!mo || mo < 1 || mo > 12 || !d || d < 1 || d > 31) return;
    const k = `${mo}-${d}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ mo, d, raw });
  };
  let m;
  const re1 = /(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/g;
  while ((m = re1.exec(s))) push(+m[2], +m[3], m[0]);
  const re2 = /(?<![\d-])(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?(?![\d:])/g;
  while ((m = re2.exec(s))) push(+m[1], +m[2], m[0]);
  const re3 = /([一二三四五六七八九十]{1,3})\s*月\s*([一二三四五六七八九十]{1,3})\s*[日号]?/g;
  while ((m = re3.exec(s))) push(cnNum(m[1]), cnNum(m[2]), m[0]);
  return out;
}

function extractDate(claim) {
  return extractDates(claim)[0] || null;
}

function datesConflict(claimDates, factDates) {
  const a = claimDates.filter((x) => x.mo);
  const b = factDates.filter((x) => x.mo);
  if (!a.length || !b.length) return false;
  return !a.some((x) => b.some((y) => x.mo === y.mo && x.d === y.d));
}

function dateHit(d, stamp) {
  const m = String(stamp || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  if (d.y && +m[1] !== d.y) return false;
  if (d.mo && +m[2] !== d.mo) return false;
  if (d.d && +m[3] !== d.d) return false;
  return true;
}

/** 引号里的片段：「…」/“…”/"…"；取最长一条。 */
function extractQuote(claim) {
  const s = String(claim || '');
  const found = [];
  for (const p of [/「([^」]{4,120})」/g, /“([^”]{4,120})”/g, /"([^"]{4,120})"/g]) {
    let m;
    while ((m = p.exec(s))) found.push(m[1].trim());
  }
  return found.sort((a, b) => b.length - a.length)[0] || '';
}

function quoteHit(q, text) {
  const a = stripPunct(q);
  const b = stripPunct(text);
  if (!a || !b) return false;
  if (b.includes(a)) return true;
  return overlap(q, text) >= 0.8;
}

/** 她说「我说过」还是「你说过」：决定该由谁的原话来作证。 */
function pronoun(claim, conv = '') {
  const s = String(claim || '');
  const V = '(说过|说|答应过|答应|讲过|讲|提到过|提到|定过|定|要求过|要求|规定过|规定)';
  // 先认「你说过/我说过」这种人称；名字可能只出现在引号里的原话中，
  // 先按名字认会把「你说过『记住我……』」误判成我自己说的。
  // 「我跟你说过」是我说给对方听，不是对方说；必须先于「你…说过」判断。
  if (new RegExp(`我[^。！？]{0,8}(?:跟|对|和|给)?你[^。！？]{0,4}${V}`).test(s)) return 'self';
  if (new RegExp(`(你说过|你答应过|你讲过|你提到过|你定过|你要求过|你跟我说过|你说)`).test(s)) return 'master';
  if (new RegExp(`(我说过|我答应过|我讲过|我提到过|我定过|我跟你说过|我说)`).test(s)) return 'self';
  // 中间插词的「你在群里说过 / 你之前提过」也要认，不能只认字面相邻。
  if (new RegExp(`(?:你|你们)[^。！？]{0,6}${V}`).test(s)) return 'master';
  if (new RegExp(`(主人|${MASTER_ALT})[^。！？]{0,16}${V}`).test(s)) return 'master';
  if (new RegExp(`(${SELF_ALT})[^。！？]{0,16}${V}`).test(s)) return 'self';
  // 裸的「他/她」：只在和主人的私聊里解成主人；群里指谁不知道，不猜。
  // 注意：不能只认「他说过」；「他说我一米五八」同样是转述，也要认。
  if (new RegExp(`(^|[^其])[他她][^。！？]{0,16}${V}`).test(s)) {
    return (MASTER_ID && new RegExp('^private:' + MASTER_ID + '(?:$|:)').test(String(conv || ''))) ? 'master' : '';
  }
  return '';
}

/** 长句里常有一段是原话、其余是解释；整句算重合会把真证据冲淡。按分句取最高重合。 */
function topicalOverlap(claim, text) {
  let best = overlap(claim, text);
  const parts = String(claim || '').split(/[，。；！？\n]/).map((x) => x.trim()).filter((x) => x.length >= 6);
  for (const part of parts) {
    const v = overlap(part, text);
    if (v > best) best = v;
  }
  return best;
}

function speakerOk(who, speaker) {
  const s = String(speaker || '');
  if (who === 'self') return new RegExp('(' + SELF_ALT + ')' + idAlt(SELF_ID) + '|^self$', 'i').test(s);
  if (who === 'master') return new RegExp('主人|' + MASTER_ALT).test(s);
  return true;
}

// 她讨论闸门/测试样本的句子，不能反过来当「这件旧事发生过」的证据。
// 例：她自己复述「第 2 条我昨天在群里跟你说过稀这个字」会把同一句再撑成有据。
function isMetaEvidence(text) {
  return /(测试样本|第\s*\d+\s*条|被拦|拦下|放行|最像的只有|闸门|词表|recallDraftGate|gate-log)/.test(String(text || ''));
}

function evidenceOf(rows, rawById, rawByLine) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (!RAW_SRC.has(String(r.src || ''))) continue;
    const row = rawById.get(String(r.id || '')) || (r.line ? rawByLine.get(Number(r.line)) : null);
    if (!row || !row.text) continue;
    const id = String(row.id || r.id || '');
    const text = norm(row.text);
    if (!text || seen.has(id + text)) continue;
    if (isMetaEvidence(text)) continue;
    seen.add(id + text);
    out.push({
      type: 'raw',
      id,
      date: norm(r.tsLocal || '') || localStamp(row.tsUtc || row.ts),
      speaker: norm((row.speaker && row.speaker.name) || '') || norm(r.speaker || ''),
      text: text.slice(0, 240),
      score: Number(r.score || 0),
      line: row._line || r.line || null,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 显式「你说过/我说过」时，证据只在对应说话人的 raw 行里找。
 * trace 的种子会被她自己的复述句抢走；主人原话往往排在后面，不能只看 top5。
 */
function directSpeakerEvidence({ rawRows, who, claim, d, q }) {
  if (!who) return [];
  const out = [];
  for (const row of rawRows) {
    const speaker = norm((row.speaker && row.speaker.name) || '');
    if (!speakerOk(who, speaker)) continue;
    const text = norm(row.text || '');
    if (!text) continue;
    if (isMetaEvidence(text)) continue;
    let score = topicalOverlap(claim, text);
    if (q && quoteHit(q, text)) score = Math.max(score, 0.95);
    else if (d && dateHit(d, localStamp(row.tsUtc || row.ts))) score = Math.max(score, Math.min(0.9, score + 0.12));
    if (score < 0.18) continue;
    out.push({
      type: 'raw',
      id: String(row.id || ''),
      date: localStamp(row.tsUtc || row.ts),
      speaker,
      text: text.slice(0, 240),
      score,
      line: row._line || null,
      direct: true,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

function answerForList(fact) {
  let v = fact && fact.answerFor;
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const p = JSON.parse(v);
    if (Array.isArray(p)) return p.map(String).filter(Boolean);
  } catch { /* 不是正经 JSON，下面按逗号拆 */ }
  return v.replace(/^\[|\]$/g, '').split(/[,，]/)
    .map((x) => x.replace(/^[\s"'\\]+|[\s"'\\]+$/g, ''))
    .filter(Boolean);
}

function factFields(fact) {
  const out = [];
  for (const x of answerForList(fact)) out.push([x, 1.0]);
  for (const x of (Array.isArray(fact.attributes) ? fact.attributes : [])) out.push([x, 1.0]);
  if (fact.锚片段) out.push([fact.锚片段, 0.95]);
  if (fact.summary) out.push([fact.summary, 0.9]);
  if (fact.text) out.push([fact.text, 0.85]);
  return out;
}

function factScore(claim, fact) {
  const c = stripPunct(claim);
  let best = 0;
  let field = '';
  for (const [txt, w] of factFields(fact)) {
    const t = stripPunct(txt);
    if (!t) continue;
    let sc = overlap(claim, txt) * w;
    if (t.length >= 4 && c.includes(t)) sc = Math.max(sc, w);
    else if (c.length >= 8 && t.includes(c)) sc = Math.max(sc, w);
    if (sc > best) { best = sc; field = txt; }
  }
  return { score: Math.min(best, 1), field };
}

function anchorOf(fact, rawById) {
  const id = String(fact.锚行 || (Array.isArray(fact.rawIds) ? fact.rawIds[0] : '') || '');
  const frag = stripPunct(fact.锚片段 || '');
  if (!id && !frag) return { ok: null, id: '', text: '', why: '没有锚（自述/判断）' };
  if (!id) return { ok: false, id: '', text: '', why: '没有锚行' };
  const row = rawById.get(id);
  if (!row) return { ok: false, id, text: '', why: `锚行 ${id} 找不到` };
  const text = norm(row.text || '');
  if (!frag) return { ok: true, id, text: text.slice(0, 240), why: '' };
  const ok = stripPunct(text).includes(frag);
  return { ok, id, text: text.slice(0, 240), why: ok ? '' : `锚片段不在锚行 ${id} 里` };
}

function factDates(fact) {
  const blob = [fact.text, fact.summary, fact.锚片段].filter(Boolean).join(' ');
  const ds = extractDates(blob);
  if (!ds.length && fact.occurredAt) {
    const s = localStamp(fact.occurredAt);
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) ds.push({ mo: +m[2], d: +m[3], raw: `${m[2]}-${m[3]}` });
  }
  return ds;
}

function factSide(fact) {
  const s = String((fact && (fact.subject || fact.holder)) || '');
  if (new RegExp('(' + SELF_ALT + ')' + idAlt(SELF_ID)).test(s)) return 'self';
  if (new RegExp('主人|' + MASTER_ALT).test(s)) return 'master';
  return '';
}

function factEvidence(fact, score, anchor, fd) {
  return {
    type: 'fact',
    id: String(fact.id || ''),
    date: fd.map((x) => x.raw).filter(Boolean).slice(0, 2).join(' / '),
    speaker: norm(fact.subject || fact.holder || ''),
    text: norm(fact.text || fact.summary || '').slice(0, 240),
    score: Number(score.toFixed(3)),
    anchorOk: anchor.ok,
    anchorWhy: anchor.why || '',
    // 摘要条和原话条要能一眼分开；无锚条不能单独撑 supported。
    mode: String(fact.mode || fact.provenance || ''),
    noAnchor: !(Array.isArray(fact.rawIds) && fact.rawIds.length),
    supersededBy: String(fact.supersededBy || ''),
  };
}

export async function verifyClaim({ storeDir, botDir, claim, conv, top = 5, signal }) {
  const c = norm(claim);
  if (!c) return { ok: false, claim: '', error: 'bad-claim', detail: '没给要验的话', method: METHOD };

  // 问句不是陈述，verify 不替 ask_xi 回答；直接说清，免得把「库里有相关条」误读成「问句成立」。
  if (/[?？]\s*$/.test(c) || /(吗|呢|是不是|要不要|有没有|多少|哪一天|哪天|什么时候|谁|什么)$/.test(c)) {
    return {
      ok: true, claim: c, verdict: 'unknown', confidence: 0, evidence: [], clues: [], successor: null,
      checks: { date: '', dates: [], quote: '', speaker: '', relative: false, promise: false, question: true },
      missing: '这是问句，verify 只核陈述；问事实用 ask_xi，问原话用 ask_raw',
      note: 'verify 只回答「这句话有没有证据」，不回答「答案是什么」。',
      method: METHOD, dataTo: '',
    };
  }

  const tr = await askTrace({ storeDir, botDir, question: c, top: Math.max(5, Number(top) || 5), signal });
  if (!tr || tr.error) {
    return {
      ok: false, claim: c, error: (tr && tr.error) || 'trace-failed',
      detail: (tr && tr.detail) || '翻账没返回', method: METHOD,
    };
  }

  const rows = Array.isArray(tr.rows) ? tr.rows : [];
  const rawRows = readRawRows(storeDir);
  const rawById = new Map();
  const rawByLine = new Map();
  for (const row of rawRows) {
    if (row.id) rawById.set(String(row.id), row);
    if (row._line) rawByLine.set(row._line, row);
  }

  const traceEvidence = evidenceOf(rows, rawById, rawByLine).slice(0, 5);
  const clues = rows.filter((r) => !RAW_SRC.has(String(r.src || ''))).slice(0, 3).map((r) => ({
    id: String(r.id || ''), date: norm(r.tsLocal || ''), src: String(r.src || ''),
    speaker: norm(r.speaker || ''), score: Number(r.score || 0),
  }));

  const d = extractDate(c);
  const claimDates = extractDates(c);
  const q = extractQuote(c);
  const who = pronoun(c, conv);
  const directEvidence = directSpeakerEvidence({ rawRows, who, claim: c, d, q });
  const rawEvidence = who
    ? [...directEvidence, ...traceEvidence.filter((e) => speakerOk(who, e.speaker))].slice(0, 5)
    : traceEvidence;
  const speakerMismatch = Boolean(who && !directEvidence.length && traceEvidence.length
    && !traceEvidence.some((e) => speakerOk(who, e.speaker)));
  const relative = /(昨天|前天|今天|上次|上回|那天|那回|刚才|刚刚)/.test(c);
  const promise = PROMISE_RE.test(c);

  // 「他给我/送我/帮我…」不是引他的话，是她对一件事情的复述。
  // 这类 claim 可以 supported，但证据必须标成「我的复述」，不能冒充主人原话。
  const thirdAction = /(^|[^其])[他她][^。！？]{0,10}(给|送|帮|带|买|做|弄|修|教|让|叫|喊|陪|找|救|养|递|寄|发)/.test(c);

  // 裸的「他/她」只有在能确定是私聊对象时才解成主人；没有 conv 或群里不猜。
  // 不猜不等于放行：带「他说过/他定过…」但认不出人，必须回 unknown，不能让 speaker 检查空着过。
  if (!who && /(^|[^其])[他她][^。！？]{0,16}(说过|说|答应过|答应|讲过|讲|提到过|提到|定过|定|要求过|要求|规定过|规定)/.test(c)) {
    return {
      ok: true, claim: c, verdict: 'unknown', confidence: 0, evidence: [], clues: [], successor: null,
      checks: { date: '', dates: [], quote: '', speaker: '', relative: false, promise: false, question: false, thirdPerson: true },
      missing: '这句用了「他/她」，但没给 conv（私聊号），认不出是谁；不猜，也不能当有据',
      note: '要么带上 private:<QQ号> 再核，要么把「他说过」改成具体的人，或说「我记不清」。',
      method: METHOD, dataTo: '',
    };
  }

  // ---- 事实层：facts.jsonl ----
  const facts = readFacts(storeDir);
  const disputedFacts = new Set();
  try {
    for (const cf of readConflicts(storeDir)) {
      if (cf && cf.status === 'disputed') { disputedFacts.add(String(cf.left || '')); disputedFacts.add(String(cf.right || '')); }
    }
  } catch { /* 冲突账读不到就按无冲突处理，不静默判有据 */ }
  let best = null;
  for (const f of facts) {
    const s = factScore(c, f);
    if (!best || s.score > best.score) best = { fact: f, ...s };
  }

  let factVerdict = 'unknown';
  let factMissing = '';
  let factConfidence = 0;
  let factEv = null;
  let factAnchorUnbacked = false;
  let factWhoMismatch = false;
  let successor = null;
  if (best && best.score >= FACT_MIN) {
    const f = best.fact;
    const anchor = anchorOf(f, rawById);
    const fd = factDates(f);
    const status = String(f.状态 || '');
    const side = factSide(f);
    const whoMismatch = Boolean(who && side && who !== side);
    factEv = factEvidence(f, best.score, anchor, fd);
    factConfidence = best.score;

    if (disputedFacts.has(String(f.id || ''))) {
      factVerdict = 'unknown';
      factMissing = `事实条 ${f.id} 还在冲突账里（disputed），没定下来；不能拿它当准数`;
    } else if (f.supersededBy && status !== '现行') {
      const succ = facts.find((x) => x.id === f.supersededBy);
      successor = succ ? { id: succ.id, text: norm(succ.text || succ.summary || '').slice(0, 200) } : null;
      factVerdict = 'superseded';
      factMissing = `这条已被 ${f.supersededBy} 换掉${successor ? `：${successor.text}` : ''}`;
    } else if (status === '现行' && datesConflict(claimDates, fd)) {
      factVerdict = 'contradicted';
      factMissing = `库里记的是 ${fd.map((x) => x.raw).join(' / ')}，不是 ${claimDates.map((x) => x.raw).join(' / ')}`;
    } else if (whoMismatch) {
      // 事实条能证明「这条事实是什么」，不能证明「是谁说的」。
      factVerdict = 'unknown';
      factWhoMismatch = true;
      factMissing = `事实条 ${f.id} 记的是${side === 'self' ? '我' : '主人'}的事，不是${who === 'self' ? '我' : '主人'}说过的话；一句事实不能证明谁开的口`;
    } else if (status === '现行') {
      // 摘要自己写着「作废/停用/取消」时，不能因为字面沾边就盖成「有据」。
      // 例：f0010 正文是「群里别再提秋秋人…16:04 那条授权作废，这句停用」，
      // claim「10-31 你说过群里可以提秋秋人」应判「换了」，不是「有据」。
      const corpus = norm([f.text, f.summary, f.answerFor].flat().join(' '));
      const claimNegative = /(不|别|没|无|取消|停用|作废|撤回|禁止|不用|无需)/.test(c);
      const claimAffirmative = !claimNegative && /(可以|能|行|允许|让|提|说|发)/.test(c);
      const revoked = /(作废|停用|取消|撤回|不再|别再|别说|不许|禁止|不算)/.test(corpus);
      // 2026-11-25 21:1x：事实条只按字面沾边就放行，数量词不核。
      // 例：claim「五条以上」撞上正文「三条以上」，仍判【有据】——我当场抓到的 bug。
      const claimUnits = numbersIn(c);
      const corpusUnits = numbersIn(corpus);
      const numMismatch = claimUnits.find((cu) => {
        const same = corpusUnits.filter((x) => x.unit === cu.unit);
        return same.length > 0 && !same.some((x) => x.n === cu.n);
      });
      if (numMismatch) {
        factVerdict = 'contradicted';
        factMissing = `库里记的是「${corpusUnits.filter((x) => x.unit === numMismatch.unit).map((x) => x.raw).join(' / ')}」，不是「${numMismatch.raw}」`;
      } else if (revoked && claimAffirmative) {
        factVerdict = 'superseded';
        successor = { id: String(f.id || ''), text: norm(f.text || f.summary || '').slice(0, 200) };
        factMissing = `这条正文自己写着「作废/停用/取消」，不能当有据；应按现在的说法：${successor.text}`;
      } else {
        factVerdict = 'supported';
      }
      factAnchorUnbacked = factEv.noAnchor || factEv.anchorOk !== true;
      if (anchor.ok === false) factMissing = `注意：事实条 ${f.id} 的锚点不成立（${anchor.why}），这句得靠 raw-log 原话撑`;
    } else if (status === '停用' || status === '过期') {
      factVerdict = 'unknown';
      factMissing = `库里这条是「${status}」，${f.supersededBy ? `被 ${f.supersededBy} 换掉` : '没有接班人'}；别当现在还作数`;
    } else if (status === '待核') {
      factVerdict = 'unknown';
      factMissing = `库里这条还是「待核」（${f.id}），没定下来`;
    }
  }

  // ---- 原话层：raw-log ----
  let rawVerdict = 'unknown';
  let rawMissing = '';
  let rawConfidence = rawEvidence.length ? rawEvidence[0].score : 0;
  if (!rawEvidence.length) {
    rawMissing = speakerMismatch
      ? (who === 'self' ? '原话不是我说的' : '原话不是主人说的')
      : '库里没翻到原话';
  } else {
    // 日期/引号/说话人只在「确实沾题」的行里算，低分的同日期行不能替一句错日期背书。
    const relevant = rawEvidence.filter((e) => topicalOverlap(c, e.text) >= (q || d ? 0.18 : 0.25));
    const dateAny = d ? relevant.some((e) => dateHit(d, e.date)) : true;
    const quoteAny = q ? relevant.some((e) => quoteHit(q, e.text)) : true;
    const speakerAny = who ? relevant.some((e) => speakerOk(who, e.speaker)) : true;
    const top = (relevant.length ? relevant : rawEvidence).reduce((a, b) => (b.score > a.score ? b : a), (relevant.length ? relevant : rawEvidence)[0]);
    const ov = topicalOverlap(c, top.text);
    // 断言里有数字时，证据必须真出现这个数字。否则「池子一共 241 条」会被
    // 一段同样在讲池子、但只提到 202/64/138 的旧话撑成【有据】。
    const claimNums = (c.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}/g, '')
      .match(/\d{1,4}/g) || []).filter((n) => n.length >= 2);
    const numberHit = !claimNums.length || claimNums.some((n) => relevant.some((e) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(e.text)));
    // 中文数字（三/五/十五）同样要核；「五条以上」不能被「三条以上」的原话撑住。
    const claimUnits = numbersIn(c);
    const unitHit = !claimUnits.length || relevant.some((e) => {
      const eu = numbersIn(e.text);
      return claimUnits.every((cu) => eu.some((x) => x.unit === cu.unit && x.n === cu.n));
    });
    const numberMatch = numberHit && unitHit;
    // 显式说话人 + 日期/引号定向找到的原话，可以比盲检索的 0.78 门槛低；
    // 但必须至少有一个日期/引号锚，且字面对得上，不能凭「同一天说过话」就判有据。
    // 没有日期/引号时，只要定向检索到说话人本人、且字面重合够高，也可以撑住转述。
    const strong = top.score >= 0.78 || Boolean(top.direct && (q || d)) || Boolean(top.direct && ov >= 0.55);
    const onTopic = ov >= (q || d ? 0.2 : 0.28);

    if (strong && onTopic && dateAny && quoteAny && speakerAny && numberMatch) {
      rawVerdict = 'supported';
    } else if (strong && top.score >= 0.85 && ov >= 0.45 && !dateAny) {
      rawVerdict = 'contradicted';
      rawMissing = `库里同话题的原话在 ${top.date}，不是 ${d ? d.raw : '你说的日子'}`;
    } else if (strong && top.score >= 0.85 && ov >= 0.45 && !speakerAny) {
      rawVerdict = 'contradicted';
      rawMissing = `库里这句是${top.speaker || '别人'}说的，不是${who === 'self' ? '我' : '主人'}`;
    } else if (!strong) {
      rawMissing = `最像的一条只有 ${top.score.toFixed(3)}，不够硬`;
    } else if (!speakerAny) {
      rawMissing = who === 'self' ? '原话不是我说的' : '原话不是主人说的';
    } else if (!numberMatch) {
      const mis = claimUnits.find((cu) => {
        const eu = numbersIn(top.text);
        const same = eu.filter((x) => x.unit === cu.unit);
        return same.length > 0 && !same.some((x) => x.n === cu.n);
      });
      rawMissing = mis ? `原话里的「${mis.raw}」对不上` : `原话里没有你说的数字 ${claimNums.join(' / ')}`;
      rawMissing = `原话里没有你说的数字 ${claimNums.join(' / ')}`;
    } else if (!onTopic) {
      rawMissing = '字面只沾一点，算不上对得上';
    } else if (!dateAny) {
      rawMissing = `日期对不上（问句里的 ${d.raw}）`;
    } else if (!quoteAny) {
      rawMissing = '引号里的原话对不上';
    } else {
      rawMissing = '没找到能对上的原话';
    }
  }

  // ---- 合并：事实层能定就定；定不了再看原话 ----
  let verdict = factVerdict !== 'unknown' ? factVerdict : rawVerdict;
  let missing = factVerdict !== 'unknown' ? factMissing : rawMissing;
  let confidence = Math.max(factConfidence, rawConfidence);
  let factBackedByRaw = false;

  // 事实条没锚（rawIds 为空）或锚核不成立时，不能单凭它说 supported。
  // 有 raw-log 原话撑 → 仍 supported，但 note 里要写明「撑住它的是原话」；
  // 没有 → 让原话层定，别拿摘要/自述当硬证据。
  if (factVerdict === 'supported' && factAnchorUnbacked) {
    if (rawVerdict === 'supported') {
      verdict = 'supported';
      missing = '';
      factBackedByRaw = true;
      confidence = Math.max(confidence, rawConfidence);
    } else {
      verdict = rawVerdict;
      confidence = rawConfidence;
      missing = `事实条 ${factEv.id} 没有原话锚（${factEv.anchorOk === null ? '自述/复盘' : (factEv.anchorWhy || '锚不成立')}），不能单凭它说 supported`
        + (rawMissing ? `；${rawMissing}` : '');
    }
  }

  // 说话人对不上 vs 真相反：我们只有我的原话时，只能说他没被原话证实，不能反推「他没说过」。
  // 事实条已经指明主体不是 claim 说的那个人时，别把 raw 层的「别人说的」升级成 contradicted。
  if (factWhoMismatch && verdict === 'contradicted') {
    verdict = 'unknown';
    confidence = factConfidence;
    missing = factMissing + (rawMissing ? `；原话层：${rawMissing}` : '');
  }

  // 承诺类：只有「现行 + 约定」且有锚的事实条能撑；光有一句原话、或一张无锚自述，不算。
  // 「承诺」两个字本身不是新承诺：带日期/引号、且 raw 原话撑住的，是在引旧话，不是现在立新誓。
  // 没有日期/引号锚的「我答应过…」仍要降成 unknown——原话只证明说过，不证明现在还作数。
  if (promise && verdict === 'supported' && !q && !d) {
    const f = best && best.score >= FACT_MIN ? best.fact : null;
    const isCurrentPromise = f && String(f.状态 || '') === '现行'
      && (String(f.kind || '') === '约定' || String(f.slot || '') === '权限')
      && !(factEv && factEv.id === String(f.id || '') && factAnchorUnbacked);
    if (!isCurrentPromise) {
      verdict = 'unknown';
      missing = '这是承诺/约定，不是事实；库里还没有带原话锚的承诺记录，一句原话只能证明说过，不能证明现在还作数';
    }
  }

  const note = verdict === 'supported'
    ? (factBackedByRaw
      ? `事实条 ${factEv.id} 没有原话锚（${factEv.anchorOk === null ? '自述/复盘' : (factEv.anchorWhy || '锚不成立')}），撑住它的是 raw-log 原话；引用时带日期和说话人。`
      : factVerdict === 'supported' && factEv && factEv.anchorOk === false
        ? `事实条 ${factEv.id} 的锚点不成立（${factEv.anchorWhy}），但 raw-log 有对得上的原话；引用时带日期和说话人。`
        : '找到对得上的证据；引用时带日期和说话人。supported 只表示有据，不是逻辑证明。')
    : verdict === 'contradicted'
      ? '找到的是另一天/另一个人；别按原说法讲，要么改口，要么说「我记不清，翻一下」。'
      : verdict === 'superseded'
        ? '这条被后来的说法换掉了；要提就提接班人，别拿旧说法当现在。'
        : '没找到能对上的证据；要么先查一次，要么把具体说法删掉、说「我记不清」。';

  // 只展示和 claim 真沾边的原话；事实层已经定性时最多补一条高置信原话，免得噪声抢眼。
  // 事实条只有在 verdict 不是 unknown 时才当证据显示；无锚条 unknown 时藏起来，不冒充证据。
  const minScore = q || d ? 0.75 : 0.6;
  const minOverlap = q || d ? 0.18 : 0.25;
  let rawShown = (verdict === 'unknown'
    ? rawEvidence.filter((e) => (e.score >= minScore && topicalOverlap(c, e.text) >= minOverlap)
      || (promise && e.score >= 0.8 && topicalOverlap(c, e.text) >= 0.1)).slice(0, 3)
    : verdict === 'supported'
      ? rawEvidence.filter((e) => (e.direct || e.score >= 0.78) && topicalOverlap(c, e.text) >= minOverlap).slice(0, 2)
      : []).map((e) => {
        const retold = thirdAction && e.speaker !== '主人' && /(^|[^其])[他她]/.test(e.text);
        const when = retold
          ? (String(e.text).match(/(\d{1,2}-\d{2})[^。！？]{0,12}(?:才给|给的|送我|给我|帮我|带我|让我|叫我)/) || [])[1] || ''
          : '';
        return { ...e, retold, retoldWhen: when };
      });
  const factShown = factEv && verdict !== 'unknown' ? factEv : null;
  // 【有据】不能没有证据可看：事实条没有、原话又被展示阈值挡掉时，
  // 至少把撑住判定的那条原话摆出来，免得「有据」变成空口。
  if (verdict === 'supported' && !factShown && !rawShown.length && rawEvidence.length) {
    const topRaw = rawEvidence
      .filter((e) => topicalOverlap(c, e.text) >= minOverlap)
      .sort((a, b) => b.score - a.score)[0];
    if (topRaw) rawShown = [{ ...topRaw, retold: false, retoldWhen: '' }];
  }
  const hasRetold = rawShown.some((e) => e.retold);
  const finalNote = hasRetold && verdict === 'supported'
    ? '撑住它的是我的复述，不是主人当时的原话；只能证明「这事她这么说过」，不能证明细节。'
    : note;

  return {
    ok: true,
    claim: c,
    verdict,
    confidence: Number(confidence.toFixed(3)),
    evidence: [factShown, ...rawShown].filter(Boolean),
    clues,
    successor,
    checks: {
      date: d ? d.raw : '',
      dates: claimDates.map((x) => x.raw),
      quote: q || '',
      speaker: who || '',
      relative,
      promise,
    },
    missing,
    note: finalNote,
    method: METHOD,
    dataTo: tr.数据到 || '',
  };
}

/** 给工具读的人话；CLI 另外输出 JSON。 */
export function formatVerify(r) {
  if (!r || r.ok === false) {
    return `【没验成】${(r && r.detail) || '未知错误'}（${(r && r.error) || 'error'}）`;
  }
  const head = r.verdict === 'supported' ? '【有据】'
    : r.verdict === 'contradicted' ? '【对不上】'
      : r.verdict === 'superseded' ? '【换了】'
        : '【没据】';
  const lines = [`${head} ${r.claim}`];
  const shown = (r.evidence || []);
  for (const e of shown) {
    if (e.type === 'fact') {
      const anchor = e.anchorOk === false ? `（锚点不成立：${e.anchorWhy}）` : '';
      const kind = e.noAnchor
        ? '（无原话锚：自述/复盘，不是谁当场说的）'
        : /summar/i.test(String(e.mode || '')) ? '（摘要，不是原话）' : '';
      lines.push(`- [事实 ${e.id}] ${e.date || '日期不明'} ${e.speaker || '主体不明'}：${e.text}（${Number(e.score).toFixed(2)}）${kind}${anchor}`);
    } else {
      const role = e.retold
        ? `（我${e.retoldWhen ? ` ${e.retoldWhen}` : ''} 的复述，不是主人原话）`
        : '';
      lines.push(`- ${e.date || '时刻不明'} ${e.speaker || '谁不明'}${role}：${e.text}（${Number(e.score).toFixed(2)}）`);
    }
  }
  if (!shown.length) lines.push('- （没有证据）');
  if (r.successor) lines.push(`- 接班人：${r.successor.id} ${r.successor.text}`);
  if ((r.clues || []).length) {
    lines.push(`线索（本子/文档，不算证据）：${r.clues.map((c) => `${c.date || '?'} ${c.id || '?'}`).join('、')}`);
  }
  if (r.missing) lines.push(`差在哪：${r.missing}`);
  if (r.dataTo) lines.push(`数据到：${r.dataTo}`);
  lines.push(r.note);
  return lines.join('\n');
}
