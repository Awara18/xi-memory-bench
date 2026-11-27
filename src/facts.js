/**
 * facts.js —— facts.jsonl 的唯一写入器。
 *
 * 2026-11-24：xi_fact 与 learn 转正原本各写一遍，字段/顺序/来源注记分叉。
 * 这里收成一条写路：校验锚、生成 id、查冲突、append；两边只负责给语义参数。
 * 冲突检测仍是字面 overlap >= 0.55 的窄判据，不做语义判断。
 */
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonl, norm, overlap } from './store.js';

export const FACTS_FILE = 'facts.jsonl';

export function readFactsRows(storeDir) {
  return readJsonl(join(storeDir, FACTS_FILE));
}

function nextFactId(facts) {
  const max = facts.reduce((m, f) => {
    const n = Number(String(f.id || '').replace(/\D/g, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return 'f' + String(max + 1).padStart(4, '0');
}

function normalizeAnswerFor(raw) {
  const out = [];
  const push = (x) => {
    let s = String(x ?? '').trim();
    s = s.replace(/^[\[("\u201c\u300c]+/, '').replace(/[\])\u201d\u300d"']+$/, '').trim();
    s = s.replace(/\\"/g, '"');
    if (s && !/^[\[\]{}",]+$/.test(s)) out.push(s);
  };
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const s = String(x ?? '').trim();
      if (/^\[/.test(s)) {
        try { const a = JSON.parse(s); if (Array.isArray(a)) { a.forEach(push); continue; } } catch { /* 不是 JSON，按单条 */ }
      }
      push(s);
    }
  } else if (raw != null) {
    const s = String(raw).trim();
    let done = false;
    if (/^\[/.test(s)) {
      try { const a = JSON.parse(s); if (Array.isArray(a)) { a.forEach(push); done = true; } } catch { /* 不是 JSON，按逗号拆 */ }
    }
    if (!done) s.split(/[，,、]/).forEach(push);
  }
  return [...new Set(out)];
}

/**
 * 写一条 fact。成功返回 { ok:true, fact, conflictNote, duplicate }；
 * 失败返回 { ok:false, error }，调用方原样回给模型。
 */
export function writeFactRow({
  storeDir,
  text,
  rawRows = null,
  rawId,
  anchor = '',
  slot = '事实',
  kind = '事实',
  summary = '',
  subject = '',
  holder = '',
  answerFor = null,
  learnedFrom = '',
  sourceNote = null,
  onConflict = null,
} = {}) {
  const t = norm(text);
  if (!t) return { ok: false, error: '没写：text 是空的' };
  const rid = String(rawId ?? '').trim();
  if (!rid) return { ok: false, error: '没写：rawId 必填——这条事实是从哪句原话来的' };
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const row = rows.find((r) => r && r.id === rid);
  if (!row) return { ok: false, error: `没写：锚点找不到，${rid} 不在 raw-log 里` };
  const rowText = String(row.text || '');
  const quote = String(anchor ?? '').trim() || rowText;
  if (!quote || !rowText.includes(quote)) {
    return { ok: false, error: `没写：锚片段在 ${rid} 的正文里找不到，一字不差才算锚。` };
  }

  const facts = readFactsRows(storeDir);
  const dup = facts.find((f) => String(f.text || '') === t && (f.rawIds || []).includes(rid));
  if (dup) return { ok: true, fact: dup, duplicate: true, conflictNote: '' };

  const id = nextFactId(facts);
  const quoted = quote === rowText;
  const fact = {
    id,
    text: t,
    subject: String(subject || '').trim() || (row.speaker && row.speaker.name) || '未写',
    holder: String(holder || '').trim(),
    ['属性']: slot,
    summary: String(summary || '').trim() || t.slice(0, 60),
    kind: String(kind || '').trim() || '事实',
    rawIds: [rid],
    anchorKind: '原话',
    mode: quoted ? 'quoted' : 'summarized',
    ['锚行']: rid,
    ['锚片段']: quote,
    ['锚sha256']: createHash('sha256').update(quote).digest('hex'),
    createdAt: new Date().toISOString(),
    supersededBy: null,
    supersededAt: null,
    suspect: false,
    ['状态']: '现行',
    slot,
    provenance: quoted ? 'quoted' : 'summarized',
    answerFor: normalizeAnswerFor(answerFor),
    scene: row.scene || '',
    sourceNote: sourceNote || {
      file: 'raw-log.jsonl',
      lines: String(rows.findIndex((r) => r && r.id === rid) + 1),
      snap: quote,
      verified: true,
      proves: quoted ? '原话整句，单行自证' : '原话的子串',
    },
    occurredAt: row.ts || null,
    occurredAtSource: 'raw',
  };
  if (learnedFrom) fact.learnedFrom = learnedFrom;

  let conflictNote = '';
  const live = facts.filter((f) => f && String(f['状态'] || '现行') === '现行'
    && String(f.slot || f['属性'] || '') === slot);
  const clash = live.find((f) => String(f.text || '') !== t && overlap(t, f.text || '') >= 0.55);
  if (clash) {
    fact['状态'] = '待核';
    fact.conflictWith = [clash.id];
    let conflictId = '';
    if (typeof onConflict === 'function') {
      const cr = onConflict({
        storeDir, kind, left: clash.id, right: id,
        reason: `同一 ${slot} 下两种说法：${String(clash.text || '').slice(0, 80)} ↔ ${t.slice(0, 80)}`,
      });
      conflictId = (cr && cr.conflict && cr.conflict.id) || '';
    }
    conflictNote = `｜冲突 ${conflictId}：新条先记「待核」，没覆盖 ${clash.id}`;
  }

  try {
    appendFileSync(join(storeDir, FACTS_FILE), JSON.stringify(fact) + String.fromCharCode(10), 'utf8');
  } catch (e) {
    return { ok: false, error: '没写：append 失败（' + (e && e.message) + '）' };
  }
  return { ok: true, fact, conflictNote };
}
