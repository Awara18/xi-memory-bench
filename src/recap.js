/**
 * recap.js —— 只读回放：上次停在哪、最近说了什么、什么还挂着。
 *
 * 2026-11-22 18:0x 我要的第一步之二：开场先看清，不靠她「想起来查」。
 * 只读 raw-log / summary.md / facts.jsonl / promises.jsonl / echo-log.jsonl；不推事件、不改状态。
 * 计划已退役（plans.jsonl 删除，统一用 jobs.json + promises.jsonl）。
 */
import { localStamp, norm, readFacts, readLastSummary, readRawRows, todayLocal, daysBetween } from './store.js';
import { readPromises } from './promises.js';
import { readCandidates, readLessons, readConflicts, readGaps } from './learn.js';
import { echoStats } from './echo.js';

const SKIP_SCENE = /doc|judgment|seed|non/i;

export function loadRecap({ storeDir, botDir, since, limit = 8 }) {
  const rows = readRawRows(storeDir).filter((r) => r && r.text && !SKIP_SCENE.test(String(r.scene || '')));
  const sinceMs = since ? Date.parse(String(since)) : NaN;
  const picked = Number.isFinite(sinceMs) ? rows.filter((r) => {
    const t = Date.parse(String(r.ts || r.tsUtc || ''));
    return Number.isFinite(t) && t >= sinceMs;
  }) : rows;

  const n = Math.max(1, Math.min(40, Number(limit) || 8));
  const recent = picked.slice(-n).map((r) => ({
    id: String(r.id || ''),
    at: localStamp(r.ts || r.tsUtc),
    who: norm((r.speaker && r.speaker.name) || '') || (r.dir === 'out' ? '我' : '谁不明'),
    dir: String(r.dir || ''),
    scene: String(r.scene || ''),
    text: norm(r.text).slice(0, 180),
  }));

  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastHuman = [...rows].reverse().find((r) => r.dir === 'in' || (r.speaker && r.speaker.name && r.speaker.name !== '我')) || null;

  const today = todayLocal();
  const openPromises = readPromises(storeDir).filter((p) => p && p.status === 'open').map((p) => ({
    id: p.id || '', text: norm(p.text).slice(0, 180), due: p.dueAt || 'none',
    late: p.dueAt && p.dueAt !== 'none' && Number.isFinite(daysBetween(p.dueAt, today)) ? daysBetween(p.dueAt, today) : null,
    origin: p.origin || '',
  }));
  const duePromises = openPromises.filter((p) => p.due !== 'none' && String(p.due) <= today);

  const allFacts = readFacts(storeDir);
  const pendingFacts = allFacts.filter((f) => f && f.状态 === '待核');
  const dueFacts = pendingFacts.filter((f) => f.待核到期 && String(f.待核到期) <= today).map((f) => ({
    id: f.id || '', text: norm(f.text).slice(0, 160), due: f.待核到期 || '',
    late: Number.isFinite(daysBetween(f.待核到期, today)) ? daysBetween(f.待核到期, today) : null,
  }));

  const summary = readLastSummary(storeDir);
  const allCandidates = readCandidates(storeDir);
  const pendingCandidates = allCandidates.filter((c) => c && c.status === 'pending');
  const trialCandidates = allCandidates.filter((c) => c && c.status === 'trial');
  const reviewDueCandidates = allCandidates.filter((c) => c && c.status === 'review-due');
  const reviewDueLessons = readLessons(storeDir).filter((l) => l && ['review-due', 'stale'].includes(l.status));
  const conflicts = readConflicts(storeDir).filter((c) => c && c.status === 'disputed');
  const gaps = readGaps(storeDir).filter((g) => g && g.status === 'open');
  let echo = null;
  try { echo = echoStats({ storeDir, days: 7 }); } catch { /* 回声账坏掉不拦回放 */ }

  return {
    ok: true,
    asOf: localStamp(new Date().toISOString()),
    dataTo: lastRow ? localStamp(lastRow.ts || lastRow.tsUtc) : '',
    lastAt: lastRow ? localStamp(lastRow.ts || lastRow.tsUtc) : '',
    lastHumanAt: lastHuman ? localStamp(lastHuman.ts || lastHuman.tsUtc) : '',
    lastHuman: lastHuman ? {
      who: norm((lastHuman.speaker && lastHuman.speaker.name) || '') || '主人',
      text: norm(lastHuman.text).slice(0, 240),
    } : null,
    recent,
    summary,
    openPromises,
    duePromises,
    pendingFacts: pendingFacts.length,
    dueFacts,
    pendingCandidates,
    trialCandidates,
    reviewDueCandidates,
    reviewDueLessons,
    conflicts,
    gaps,
    echo,
    counts: {
      rawRows: rows.length,
      openPromises: openPromises.length,
      duePromises: duePromises.length,
      pendingFacts: pendingFacts.length,
      dueFacts: dueFacts.length,
      pendingCandidates: pendingCandidates.length,
      trialCandidates: trialCandidates.length,
      reviewDueCandidates: reviewDueCandidates.length,
      reviewDueLessons: reviewDueLessons.length,
      conflicts: conflicts.length,
      gaps: gaps.length,
      echoOut: echo ? echo.total : 0,
      echoPaired: echo ? echo.paired : 0,
      echoNoReply: echo ? echo.noReply : 0,
    },
    note: '只读回放：最近几句不是全部上下文；承诺/候选到期只列出来，不推事件、不改状态。',
    method: 'recap-readonly-v1',
  };
}

export function formatRecap(r, { sections = null, compact = false } = {}) {
  if (!r || r.ok === false) return `【回放失败】${(r && r.detail) || '未知错误'}`;
  const want = (name) => !sections || !sections.length || sections.includes(name);
  const take = (arr, n) => (arr || []).slice(-(compact ? Math.min(n, 2) : n));
  const lines = [`【回放】数据到 ${r.dataTo || '不明'}；上次说话 ${r.lastAt || '不明'}`];
  if (want('recent') && r.lastHuman) lines.push(`上次他说的：${r.lastHuman.who}：${r.lastHuman.text}`);
  if (want('recent')) {
    lines.push('最近：');
    for (const x of take(r.recent, 4)) lines.push(`- ${x.at || '时刻不明'} ${x.who}${x.dir === 'out' ? '（我）' : ''}：${x.text}`);
    if (!(r.recent || []).length) lines.push('- （这段时间没有对话）');
  }
  if (want('promises') && (r.openPromises || []).length) {
    lines.push('还没了结的承诺：');
    for (const p of take(r.openPromises, 8)) {
      const late = p.late != null && p.late > 0 ? `，晚 ${p.late} 天` : '';
      lines.push(`- ${p.id}｜${p.due === 'none' ? '没定期限' : `到期 ${p.due}${late}`}｜${p.text}`);
    }
  }
  if (want('promises') && (r.dueFacts || []).length) {
    lines.push('待核到期：');
    for (const f of take(r.dueFacts, 5)) lines.push(`- ${f.id} ${f.text}（到期 ${f.due}）`);
  }
  if (want('candidates') && (r.pendingCandidates || []).length) {
    lines.push('待审候选（不是事实）：');
    for (const c of take(r.pendingCandidates, 5)) lines.push(`- ${c.id}｜${c.kind}｜${c.risk}｜${String(c.text || '').slice(0, 100)}`);
  }
  if (want('candidates') && (r.trialCandidates || []).length) {
    lines.push('试用中（候选，未定）：');
    for (const c of take(r.trialCandidates, 5)) lines.push(`- ${c.id}｜${c.kind}｜到 ${String(c.trialUntil || '').slice(0, 10)}｜${String(c.text || '').slice(0, 100)}`);
  }
  if (want('candidates') && (r.reviewDueCandidates || []).length) {
    lines.push('候选回看：');
    for (const c of take(r.reviewDueCandidates, 5)) lines.push(`- ${c.id}｜${c.kind}｜${String(c.text || '').slice(0, 100)}`);
  }
  if (want('lessons') && (r.reviewDueLessons || []).length) {
    lines.push('到期回看：');
    for (const l of take(r.reviewDueLessons, 5)) lines.push(`- ${l.id}｜${l.status}｜${String(l.text || '').slice(0, 100)}`);
  }
  if (want('conflicts') && (r.conflicts || []).length) lines.push(`冲突 ${r.conflicts.length} 条（disputed，不覆盖；用 xi_review 处置）`);
  if (want('gaps') && (r.gaps || []).length) lines.push(`缺口 ${r.gaps.length} 条（没答上的；用 xi_review 处置）`);
  if (want('echo') && r.echo && r.echo.total) {
    lines.push(`回声账（近 7 天）：出站 ${r.echo.total}｜配对 ${r.echo.paired}｜等回 ${r.echo.pending}｜被覆盖 ${r.echo.superseded}｜没人回 ${r.echo.noReply}｜配对率 ${Math.round((r.echo.pairRate || 0) * 100)}%`);
  }
  if (want('summary') && r.summary && r.summary.text) {
    const t = compact ? String(r.summary.text).slice(0, 500) : r.summary.text;
    lines.push(`上次摘要（${r.summary.stamp || '时刻不明'}）：${t}`);
  }
  if (!compact) lines.push(r.note);
  return lines.join('\n');
}
