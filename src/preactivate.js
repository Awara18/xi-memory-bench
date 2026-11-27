/**
 * preactivate.js —— 每轮开口前，把两条「可能相关」的旧事推到眼前。
 *
 * 抄的是 memory-core 的 preactivateLines=2，但改了三点：
 *   - 候选只从 xi 自己的库来（承诺 / facts / raw-log），不另建一套记忆；
 *   - 每条都带 ↩日期 和来源，明说「候选，不是原话，不是证据」；
 *   - 只推 2 条，推不中就说没翻到，不硬凑。
 *
 * 它只读，不写库、不推事件。qqbot 要在入站时调它，得走 tools/xi-bridge.mjs。
 */
import { daysBetween, localStamp, norm, overlap, readFacts, readRawRows, todayLocal } from './store.js';
import { weightFactor } from './weights.js';
import { readPromises } from './promises.js';
import { readCandidates, readConflicts, readLessons, readPreferences } from './learn.js';

const SKIP_SCENE = /doc|judgment|seed|non/i;

function lastHumanRow(rows) {
  return [...rows].reverse().find((r) => r && r.dir === 'in' && r.text && !SKIP_SCENE.test(String(r.scene || ''))) || null;
}

function dueScore(p, today) {
  if (p.dueAt === 'none' || !p.dueAt) return 0;
  if (String(p.dueAt) < today) return 0.35;
  if (String(p.dueAt) === today) return 0.25;
  const d = daysBetween(today, p.dueAt);
  return Number.isFinite(d) && d <= 3 ? 0.12 : 0;
}

function sourceDate(p) {
  const raw = p.source && (p.source.date || p.source.ts);
  const s = localStamp(raw || p.madeAt);
  return s ? s.slice(0, 10) : '';
}

/**
 * @returns {{ok:boolean,cue:string,candidates:Array,text:string,dataTo:string,note:string}}
 */
export function loadPreactivation({ storeDir, botDir, cue, limit = 2 } = {}) {
  const rows = readRawRows(storeDir).filter((r) => r && r.text && !r.duplicateOf && !SKIP_SCENE.test(String(r.scene || '')));
  const last = lastHumanRow(rows);
  const q = norm(cue || (last && last.text) || '');
  const today = todayLocal();
  const seen = new Set();
  const cands = [];

  const push = (c) => {
    const k = norm(c.text).slice(0, 60);
    if (!k || seen.has(k)) return;
    seen.add(k);
    cands.push(c);
  };

  // 1) 挂着的承诺。到期/逾期优先，其次按字面相关。
  for (const p of readPromises(storeDir).filter((x) => x.status === 'open')) {
    const ov = q ? overlap(q, p.text) : 0;
    const sc = ov * 0.65 + dueScore(p, today);
    if (!q && !dueScore(p, today)) continue;
    if (q && sc < 0.1) continue;
    push({
      kind: 'promise',
      id: p.id,
      date: sourceDate(p),
      who: '',
      text: p.text,
      due: p.dueAt,
      score: Number(sc.toFixed(3)),
      tag: '承诺卡（改写过的记忆，不是原话）',
    });
  }

  // 2) facts：只取现行且不在冲突账里的；overlap 命中才推，不拿无关条目凑数。
  const disputed = new Set();
  try {
    for (const c of readConflicts(storeDir)) {
      if (c && c.status === 'disputed') { disputed.add(String(c.left || '')); disputed.add(String(c.right || '')); }
    }
  } catch { /* 冲突账读不到不拦预激活 */ }
  if (q) {
    for (const f of readFacts(storeDir)) {
      if (!f || String(f.状态 || '') !== '现行') continue;
      if (disputed.has(String(f.id || ''))) continue;
      const body = [f.summary, f.text, ...(Array.isArray(f.answerFor) ? f.answerFor : [])].filter(Boolean).join(' ');
      const sc = overlap(q, body) * 0.6 * weightFactor(storeDir, f.id);
      if (sc < 0.12) continue;
      push({
        kind: 'fact',
        id: String(f.id || ''),
        date: f['锚行'] ? localStamp(f.updatedAt || f.createdAt).slice(0, 10) : '',
        who: norm(f.subject),
        text: norm(f.summary || f.text).slice(0, 160),
        due: '',
        score: Number(sc.toFixed(3)),
        tag: '摘要（改写过的记忆，不是原话）',
      });
    }
  }

  // 3) 偏好：单独存 preferences.jsonl，但和 facts 共用同一个查询口。
  if (q) {
    for (const p of readPreferences(storeDir)) {
      if (!p || p.status !== 'active') continue;
      const sc = overlap(q, p.text) * 0.6;
      if (sc < 0.12) continue;
      push({
        kind: 'preference',
        id: String(p.id || ''),
        date: localStamp(p.createdAt).slice(0, 10),
        who: '我',
        text: norm(p.text).slice(0, 160),
        due: '',
        score: Number(sc.toFixed(3)),
        tag: '偏好（改写过的记忆，不是原话）',
      });
    }
  }

  // 4) 试用中的候选：可以带，但必须标明「未定」，不能当事实用。
  if (q) {
    for (const c of readCandidates(storeDir)) {
      if (!c || c.status !== 'trial') continue;
      const sc = overlap(q, c.text) * 0.55;
      if (sc < 0.15) continue;
      push({
        kind: 'trial',
        id: String(c.id || ''),
        date: localStamp(c.createdAt).slice(0, 10),
        who: '',
        text: norm(c.text).slice(0, 160),
        due: '',
        score: Number(sc.toFixed(3)),
        tag: '试用中，未定（候选，不是事实）',
      });
    }
  }

  // 5) 教训：只挑「遇到…先…」能当动作使的；最多一条，挑不中不给。
  if (q) {
    let best = null;
    for (const l of readLessons(storeDir)) {
      if (!l || l.status !== 'active') continue;
      const prevention = norm(l.lesson && l.lesson.prevention);
      if (!prevention || !/遇到[\s\S]{0,60}?先/.test(prevention)) continue;
      const body = [l.text, prevention, l.lesson && l.lesson.notWhen].filter(Boolean).join(' ');
      const sc = overlap(q, body);
      if (sc < 0.1) continue; // 教训是长句，cue 的二元组召回天然低；只碰「签字」也认
      if (!best || sc > best.score) {
        best = {
          kind: 'lesson',
          id: String(l.id || ''),
          date: localStamp(l.updatedAt || l.createdAt).slice(0, 10),
          who: '',
          text: prevention.slice(0, 160),
          due: '',
          score: Number(sc.toFixed(3)),
          tag: '教训（转正，不是事实；当动作使）',
        };
      }
    }
    if (best) push(best);
  }

  // 6) 原话：跳过最近 12 句（前缀里已经有最近的，别重复），只找更早的。
  if (q) {
    const older = rows.slice(0, Math.max(0, rows.length - 12));
    for (const r of older) {
      const sc = overlap(q, r.text) * 0.9;
      if (sc < 0.14) continue;
      push({
        kind: 'raw',
        id: String(r.id || ''),
        date: localStamp(r.ts || r.tsUtc).slice(0, 10),
        who: norm((r.speaker && r.speaker.name) || '') || (r.dir === 'out' ? '我' : '谁不明'),
        text: norm(r.text).slice(0, 110),
        due: '',
        score: Number(sc.toFixed(3)),
        tag: '原话（可当线索；要引用先核对整行）',
      });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const picked = cands.slice(0, Math.max(1, Math.min(3, Number(limit) || 2)));
  const lines = [];
  if (!picked.length) {
    lines.push('【预激活】没翻到和这句对得上的旧事。要断言具体日期/原话，先 xi_verify；没据就别把话说死。');
  } else {
    lines.push('【预激活｜候选，不是原话，不是证据】');
    for (const c of picked) {
      const head = c.kind === 'promise'
        ? `↩${c.date || '日期不明'} 承诺 ${c.id}${c.due && c.due !== 'none' ? `（到期 ${c.due}）` : '（没定期限）'}`
        : c.kind === 'fact'
          ? `↩${c.date || '日期不明'} ${c.who || '摘要'}［${c.id}］`
          : c.kind === 'preference'
            ? `↩${c.date || '日期不明'} 偏好［${c.id}］`
            : c.kind === 'trial'
              ? `↩${c.date || '日期不明'} 试用候选［${c.id}］`
              : c.kind === 'lesson'
                ? `↩${c.date || '日期不明'} 教训［${c.id}］`
                : `↩${c.date || '时刻不明'} ${c.who}`;
      lines.push(`- ${head}：${c.text}〔${c.tag}〕`);
    }
    lines.push('要拿这些当话讲，先 xi_verify；卡和摘要都可能错，原话才算证据。');
  }

  const dataTo = last ? localStamp(last.ts || last.tsUtc) : '';
  return {
    ok: true,
    cue: q,
    candidates: picked,
    text: lines.join('\n'),
    dataTo,
    note: '预激活只读；候选不保证对，推不中就说没翻到。',
    method: 'preactivate-v1',
  };
}

/** 会话开头的前缀块：最多 5 条挂着的事。没有就返回空串。 */
/** 会话开头的前缀块：把已转正的机器教训端到眼前，但标明不是事实、不是手写段。 */
export function lessonsPromptBlock(storeDir, limit = 3) {
  const active = readLessons(storeDir).filter((l) => l && l.status === 'active');
  if (!active.length) return '';
  const lines = ['## 机器教训（lessons.jsonl 转正；不是事实，不是原话）', ''];
  for (const l of active.slice(0, Math.max(1, Math.min(5, Number(limit) || 3)))) {
    const body = norm((l.lesson && (l.lesson.prevention || l.lesson.resolution)) || l.text).slice(0, 180);
    if (!body) continue;
    lines.push(`- ${l.id}｜${body}`);
  }
  lines.push('', '这些是转正后的动作提醒；和 `PARTNER.md` 手写教训重复时，以手写段为准。');
  return lines.join(String.fromCharCode(10));
}

export function openLoopsBlock(storeDir, limit = 5) {
  const today = todayLocal();
  const open = readPromises(storeDir).filter((p) => p.status === 'open');
  if (!open.length) return '';
  const rows = open.map((p) => ({
    p,
    rank: p.dueAt === 'none' ? '9999-12-31' : String(p.dueAt || '9999-12-31'),
    late: p.dueAt !== 'none' && p.dueAt ? daysBetween(p.dueAt, today) : null,
  })).sort((a, b) => a.rank.localeCompare(b.rank));
  const lines = ['## 还没了结的（开场先看，不是全部）', ''];
  for (const x of rows.slice(0, Math.max(1, Math.min(10, Number(limit) || 5)))) {
    const late = x.late != null && x.late > 0 ? `，晚 ${x.late} 天` : '';
    lines.push(`- ${x.p.id}｜${x.p.dueAt === 'none' ? '没定期限' : `到期 ${x.p.dueAt}${late}`}｜${norm(x.p.text).slice(0, 120)}`);
  }
  lines.push('', '关它要给凭据（文件 / URL / 工具回执 / 原话行号）：xi_promise action=close。写一句「做完了」不算。');
  return lines.join('\n');
}
