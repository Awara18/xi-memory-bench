/**
 * cortico-world-xi-memory —— 写入口 remember_raw + 被动采集（v0.3）。
 *
 * 采集来源（11-05 21:20 定）：data/fact-store.json，按 hash 增量读。
 *   它是现有记忆系统写的真发言（QQ / 桌宠），不是事件库那种内部流水。
 *   代价：别人的库，格式变了会断 —— 所以读不到就报错重试，不许 catch 吞了当没有。
 *
 * speaker 判据（她 21:20 用真数据验过）：
 *   scope=qq:<号> + layer=原话   → 那个号的人（查 aliases.json 的 qq→名）
 *   scope=qq:<号> + layer=她说   → 我自己（dir=out）
 *   scope=desktop-pet.text      → 剥掉「主人:」前缀，speaker=主人
 *   暂不收：group:*、qq:said（后者没有 scene，标不出地点）
 *
 * 不回头补历史：第一次启动只锚定各 scope 当前最大 createdAt，写 0 条。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normForSeg, segmentText, isDictWord } from './segment.js';
import { askTrace } from './trace.js';
import { verifyClaim, formatVerify } from './verify.js';
import { loadRecap, formatRecap } from './recap.js';
import {
  addPromise, closePromise, dropPromise, extractPromise, formatPromiseList,
  formatReview, listPromises, reviewPromises, autoDropFalseCaptures,
} from './promises.js';
import { loadPreactivation, lessonsPromptBlock, openLoopsBlock } from './preactivate.js';
import { logCitations } from './citations.js';
import { buildBrief } from './brief.js';
import { gateDraft, formatGate } from './gate.js';
import { overlap } from './store.js';
import { recordOutboundEcho, pairEcho, sweepEcho, readEcho, echoStats, formatEcho } from './echo.js';
import {
  addJob, dueJobs, ensureDefaultJobs, formatJobList, markJobFired, markJobSkipped,
  removeJob, restoreJob, setJobEnabled,
} from './jobs.js';
import { formatAt, scheduleText } from './schedule.js';
import { nowLine } from './clock.js';
import { writeFactRow } from './facts.js';
import {
  addCandidate, showCandidate, approveCandidate, selfApproveCandidate,
  rejectCandidate, promoteCandidate, sweepLearning, readCandidates,
  formatCandidate, formatCandidateList, formatReview as formatLearnReview,
  learningCounts, recordGap, autoLessonFromFailure, recordConflict, readConflicts,
  closeGap, resolveConflict, autoPreferenceScan, autoPromoteFailureLessons,
} from './learn.js';
import { readUrlCandidate } from './reading.js';
import { MASTER_ALT, MASTER_NAMES, SELF_NAMES, SELF_ID, SELF_NAME } from './identity.js';


const POLL_MS = 5000;
/** scene 只许这几个字面值（我 11-10 18:4x 定）。不在里头就写待核，别落自由文本。 */
const SCENE_ENUM = new Set(['private', 'group', 'desktop', 'doc', 'judgment', 'seed', 'non']);
const SKIP_SCOPES = new Set(['qq:said']);
/** 待核到期提醒的环境提示词模板（role=envPrompt）；11-14 21:1x 主人选方案一。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
const INGEST_SCOPES = (scope) => (scope.startsWith('qq:') && !SKIP_SCOPES.has(scope)) || scope === 'desktop-pet.text';

// ── 2026-11-21 21:0x：入站直采用的两个纯函数，从 memory 世界搬过来 ──
// 为什么要有：原来入站全靠 memory 世界把话写进 fact-store，再从这里读。
// 那个世界一关，新说的话就一条都进不来——「只留一个 xi」之前必须先把这条接上。

/** 事件是不是「真人入站」。只认 origin=external，再排掉 bot 自言、工具回执、交接笔记这些。 */
function isInboundUser(e) {
  if (!e || e.origin !== 'external') return false;
  const meta = e.meta || {};
  if (meta.role === 'assistant' || meta.role === 'bot' || meta.self === true) return false;
  if (/撤回了一条消息/.test(String(e.text ?? ''))) return false;
  if (/\.self$/.test(String(e.senderKey ?? ''))) return false;
  if (meta.kind === 'activity' || meta.kind === 'delivered') return false;
  if (e.source === 'desktop-pet' && e.type === 'desktop-pet.touch') return false;
  if (e.type === 'persona' || e.senderKey === 'persona') return false;
  if (e.type === 'handoff-note') return false;
  if (String(e.text ?? '').startsWith('# 交接笔记')) return false;
  if (e.source === 'bilibili-video' || e.source === 'surfing' || e.source === 'socialmedia') return false;
  return true;
}

/** 只留人说出口的那句：剥渠道前缀（它前面全是脚手架）、剥消息号、剥重启补投的脚手架。 */
function stripReplayScaffold(t) {
  let s = String(t ?? '');
  s = s.replace(/^\s*【补投·(?:私聊|群聊)】\s*/u, '');
  s = s.replace(/\s*（这条是重启前没来得及回的，直接回它。）\s*$/u, '');
  return s.trim();
}

export function cleanCaptureText(t) {
  let s = stripReplayScaffold(String(t ?? '').replace(/\s+/g, ' ').trim());
  if (!s) return '';
  const m = s.match(/【QQ(?:私聊|群)[^】]*】\s*[:：]\s*/u);
  if (m && m.index !== undefined) {
    s = s.slice(m.index + m[0].length);
  } else {
    let prev = '';
    while (prev !== s) { prev = s; s = s.replace(/^\[[^\]]*\]\s*/u, ''); }
  }
  s = s.replace(/^#\d+\s*/u, '');
  return s.trim();
}

class XiMemoryWorld {
  id = 'xi-memory';

  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.timer = null;
    this._firingJobs = false;
    this._phase = 'idle';
    this._lastPrefScanAt = 0;
    this._lastAutoPromoteAt = 0;
    // 2026-11-27 01:5x：回声清扫每 5 秒读一遍 echo-log、每次调用 tick 都读整本 raw-log，
    // 没人说话时也一样（实测 12 次/分 × 14.7MB）。清扫按分钟就够，读数交给 captureSent 自己判空。
    this._lastEchoSweepAt = 0;
  }

  get botDir() { return (this.ctx && this.ctx.botDir) || ''; }
  get storeDir() { return join(this.botDir, 'workspace', 'xi-memory'); }
  get rawFile() { return join(this.storeDir, 'raw-log.jsonl'); }
  get stateFile() { return join(this.storeDir, 'collector-state.json'); }
  get errorFile() { return join(this.storeDir, 'collector-errors.log'); }
  get factStore() { return join(this.botDir, 'data', 'fact-store.json'); }
  get sentFile() { return join(this.botDir, 'data', 'qq-sent.jsonl'); }
  get aliases() { return join(this.storeDir, 'aliases.json'); }
  get identityFile() { return join(this.storeDir, 'identity.json'); }

  /** 缺口：同一 scope、同一小时、相邻两条差 >= 5 分钟才算一跳。补不回来，只求看得见。 */
  logGap(scope, prevCreatedAt, curCreatedAt) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      const fmt = (t) => new Date(t * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const mins = Math.round((curCreatedAt - prevCreatedAt) / 60);
      appendFileSync(join(this.storeDir, 'collector-gaps.log'),
        `${new Date().toISOString()} scope=${scope} 缺口 ${fmt(prevCreatedAt)} → ${fmt(curCreatedAt)}（${mins} 分钟）` + String.fromCharCode(10), 'utf8');
    } catch (e) { this.logError('logGap', e); }
  }

  logError(where, e) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(this.errorFile, `${new Date().toISOString()} ${where}: ${(e && e.stack) || e}` + String.fromCharCode(10), 'utf8');
    } catch { /* 连日志都写不了，只能放弃 */ }
  }

  loadState() {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch (e) {
      if (e && e.code !== 'ENOENT') this.logError('loadState', e);
      return null;
    }
  }
  saveState(s) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(s, null, 1), 'utf8');
    } catch (e) { this.logError('saveState', e); }
  }

  readRows() {
    let buf;
    try { buf = readFileSync(this.rawFile, 'utf8'); }
    catch (e) { if (e && e.code !== 'ENOENT') this.logError('readRows', e); return []; }
    const out = [];
    let bad = 0;
    let fresh = 0;
    this._badJsonLines = this._badJsonLines || new Set();
    for (const line of buf.split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {
        bad++;
        const fp = line.slice(0, 160);
        if (!this._badJsonLines.has(fp)) { this._badJsonLines.add(fp); fresh++; }
      }
    }
    // 坏一行不许把整本账读成空：否则去重全失效，下一次采集会把历史再灌一遍。
    // 但同一个坏行只报一次，避免每 5 秒刷一遍错误日志。
    if (bad && fresh) this.logError('readRows:json', new Error(`${bad} 行坏 JSON 已跳过（新增 ${fresh} 条坏行）`));
    return out;
  }
  nextId(rows) {
    const max = rows.reduce((m, r) => {
      const n = Number(String(r.id || '').replace(/\D/g, ''));
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    return 'r' + String(max + 1).padStart(6, '0');
  }

  /** 身份的唯一出处：master.qq / names / 暗号 都从 identity.json 读。 */
  identity() {
    try { return JSON.parse(readFileSync(this.identityFile, 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT') this.logError('identity', e); return null; }
  }
  masterQq() { return String((this.identity() || {}).master?.qq || ''); }
  /** 主人的所有规范名（主人、主人…）：主体比对按「同一个人」算，不按单一昵称。 */
  masterNames() {
    const id = this.identity() || {};
    return [...new Set([...(id.master?.names || []), '主人'].filter(Boolean))];
  }

  /** qq 号 → 规范名；查不到就返回 null。 */
  nameOfQq(qq) {
    try {
      const d = JSON.parse(readFileSync(this.aliases, 'utf8'));
      for (const [name, v] of Object.entries(d.people ?? {})) {
        if (v && String(v.qq || '') === String(qq)) return name;
      }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('nameOfQq', e); }
    return null;
  }

  /** 读 fact-store。读半截（正在被写）就抛，由调用方记错并下轮重试 —— 不许当没有。 */
  /** 昵称 → qq；查不到返回 null。 */
  qqOfName(name) {
    try {
      const d = JSON.parse(readFileSync(this.aliases, 'utf8'));
      for (const [canon, v] of Object.entries(d.people ?? {})) {
        if (!v) continue;
        if (canon === name || (v.aliases ?? []).includes(name)) return String(v.qq || '') || null;
      }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('qqOfName', e); }
    return null;
  }

  readFactStore() {
    let raw;
    try {
      raw = readFileSync(this.factStore, 'utf8');
    } catch (e) {
      // 文件不在了 = 那个世界已退役（2026-11-21 23:39 主人删了 memory 的 278M），不是错误。
      // 只留一条痕迹，不要每 5 秒刷一遍错误日志。
      if (e && e.code === 'ENOENT') {
        if (!this._factStoreGone) {
          this._factStoreGone = true;
          this.logError('readFactStore', new Error('fact-store.json 已不存在（memory 世界 2026-11-21 23:39 删除），导入已停'));
        }
        return {};
      }
      throw e;
    }
    const d = JSON.parse(raw);                        // 抛异常是设计：坏 JSON 必须被看见
    return d && d.scopes ? d.scopes : {};
  }

  /** 从一批 scope 里挑出新条目。 */
  pickNew(scopes, anchors) {
    const out = [];
    for (const [scope, list] of Object.entries(scopes)) {
      if (!INGEST_SCOPES(scope) || !Array.isArray(list)) continue;
      const floor = Number(anchors[scope] ?? 0);
      let max = floor;
      for (const e of list) {
        const t = Number(e && e.createdAt);
        if (!Number.isFinite(t)) continue;
        if (t <= floor) continue;
        if (t > max) max = t;
        out.push({ scope, entry: e, createdAt: t });
      }
      anchors[scope] = max;
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 出站原文集合（我 11-20 21:27：按发送者判，不靠昵称）。
   *  memory 世界会把「我说的话」也写进主人的 scope，于是采进来变成 dir=in/主人。
   *  qq-sent.jsonl 是我们自己发出去的那一份，文本能对上就是「我说的」，不看昵称。
   *  mtime 变了才重读；只读，不改。 */
  sentTexts() {
    let st;
    try { st = statSync(this.sentFile); } catch { return null; }
    if (this._sentTexts && this._sentTextsMtime === st.mtimeMs) return this._sentTexts;
    const set = new Set();
    try {
      for (const line of readFileSync(this.sentFile, 'utf8').split(String.fromCharCode(10))) {
        if (!line.trim()) continue;
        try { set.add(String(JSON.parse(line).text ?? '').replace(/\s+/g, ' ').trim()); } catch { /* 坏行跳过 */ }
      }
    } catch { return null; }
    this._sentTexts = set; this._sentTextsMtime = st.mtimeMs;
    return set;
  }

  /** 引用块单独立字段（我 11-20 21:27：别拼进正文，拼进去早晚污染检索）。
   *  认两种头：「[2026-11-12 20:08] 用户：…」和「【QQ群 …】名字(QQ:…)：…」。
   *  返回 {quote, body}；没有引用头时 quote 为 null、body 是原文。 */
  splitQuote(text) {
    const t = String(text || '');
    const m1 = /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*(?:用户|主人|我)[：:]\s*/.exec(t);
    if (m1) {
      const rest = t.slice(m1[0].length);
      const nl = rest.indexOf(String.fromCharCode(10));
      if (nl < 0) return { quote: t.slice(0, m1[0].length + rest.length), body: '' };
      return { quote: t.slice(0, m1[0].length + nl).trim(), body: rest.slice(nl + 1).trim() };
    }
    const m2 = /^【(?:QQ群|私聊)[^】]*】[^：\n]{1,40}[：:]\s*/.exec(t);
    if (m2) {
      const rest = t.slice(m2[0].length);
      const nl = rest.indexOf(String.fromCharCode(10));
      if (nl < 0) return { quote: null, body: rest.trim() };
      return { quote: t.slice(0, m2[0].length + nl).trim(), body: rest.slice(nl + 1).trim() };
    }
    return { quote: null, body: t };
  }

  toRecord({ scope, entry, createdAt }) {
    const raw = String(entry.text ?? '').trim();
    if (!raw) return null;
    const { quote, body } = this.splitQuote(raw);
    if (quote && !body) {
      // 整条就是个引用块：不是谁说的话，别当消息收（引用块单立字段，不拼正文）
      return { text: '', quote, drop: 'quote-only' };
    }
    const text = body || raw;
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const sent = this.sentTexts();
    if (sent && (sent.has(norm(text)) || sent.has(norm(raw)))) {
      // 文本与我们发出的那份一致 → 是我说的，不是主人说的
      return { text, quote, speakerId: 'self', speakerName: '我', scene: 'private', dir: 'out' };
    }
    let speaker;
    let dir = 'in';
    let scene;
    if (scope === 'desktop-pet.text') {
      const m = /^主人[:：]\s*/.exec(text);
      // 桌宠：主人在桌宠里的号就是他的 qq；昵称照看到的存。
      return { text: m ? text.slice(m[0].length) : text, speakerId: this.masterQq(), speakerName: (this.identity() || {}).master?.names?.[1] || '主人', scene: 'desktop', dir };
    }
    const qq = scope.slice(3);
    const layer = String(entry.layer ?? '');
    if (layer === '她说') return { text, speakerId: 'self', speakerName: '我', scene: 'private', dir: 'out' };
    // 只认号判 speaker；昵称只做显示，取 aliases 里的规范名，取不到就用号。
    const name = this.nameOfQq(qq) || qq;
    scene = 'private';
    return { text, speakerId: qq, speakerName: name, scene, dir };
  }

  /** 一轮采集：读到新条目就写；读失败就记日志，下轮重试。 */
  /**
   * 消息号台账（我 11-10 定）：把 known-messages 里的 id→时刻抄一份自己的 append-only。
   *
   * 为什么抄：known-messages 是别人写的，会被覆盖/裁剪；私聊正文里没有消息号，
   * 一旦号丢了就永远接不回事件时刻。这份台账只追加，谁都不改。
   * hash 拿不到（known 里没有正文），留 null —— 不编。
   */
  mirrorMsgIds() {
    const src = join(this.botDir, 'data', 'qqbot-known-messages.json');
    const dest = join(this.botDir, 'data', 'xi-msgid-log.jsonl');
    let st;
    try { st = statSync(src); } catch { return; }
    if (this._msgIdMtime === st.mtimeMs) return;
    let known;
    try { known = JSON.parse(readFileSync(src, 'utf8')).knownMessages || {}; }
    catch (e) { this.logError('msgid-read', e); return; }
    this._msgIdMtime = st.mtimeMs;
    const seen = this._msgIdSeen || (this._msgIdSeen = (() => {
      const s = new Set();
      try {
        for (const line of readFileSync(dest, 'utf8').split(String.fromCharCode(10))) {
          if (!line.trim()) continue;
          try { s.add(JSON.parse(line).message_id); } catch { /* 坏行跳过，不让台账挡写 */ }
        }
      } catch { /* 还没有台账，正常 */ }
      return s;
    })());
    const todo = [];
    for (const [id, v] of Object.entries(known)) {
      if (seen.has(id)) continue;
      todo.push({ message_id: id, conv: v.conv || null, ts: Number.isFinite(v.ts) ? v.ts : null, hash: null, seenAt: Date.now() });
    }
    if (!todo.length) return;
    todo.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    try {
      appendFileSync(dest, todo.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
      for (const r of todo) seen.add(r.message_id);
    } catch (e) { this.logError('msgid-append', e); }
  }

  /** scene 是派生字段：正文前缀说了算，不信上游给的。 */
  deriveScene(text, fallback) {
    const t = typeof text === 'string' ? text : '';
    if (t.startsWith('【QQ群')) return 'group';
    if (t.startsWith('【QQ私聊')) return 'private';
    return fallback;
  }

  /** 非人说话人（笔记 / 文档 / 种子 / 旧库判断层）：本来就没有 QQ，不算漏 key。 */
  isNonSpeaker(speakerId, scene) {
    return /^(note|doc|seed|judgment):/.test(String(speakerId ?? ''))
      || /^judgment:/.test(String(scene ?? ''));
  }

  /** 别名表，缓存着；文件改了才重读。 */
  loadSpeakerAliases() {
    const p = join(this.storeDir, 'speaker-alias.json');
    let st;
    try { st = statSync(p); } catch { return this._aliasMap || null; }
    if (this._aliasMtime === st.mtimeMs && this._aliasMap) return this._aliasMap;
    try {
      this._aliasMap = JSON.parse(readFileSync(p, 'utf8')).map || {};
      this._aliasMtime = st.mtimeMs;
    } catch (e) { this.logError('alias-read', e); }
    return this._aliasMap;
  }

  selfQq() {
    const q = (this.identity() || {})?.self?.qq;
    return q ? String(q) : null;
  }

  /** speakerKey 只许是纯数字 QQ。映射不出来就返回 null，由调用方记进待核。 */
  deriveSpeakerKey(speakerId, speakerName, text) {
    const id = String(speakerId ?? '');
    if (/^\d{5,}$/.test(id)) return id;
    const map = this.loadSpeakerAliases() || {};
    if (id === '我' || id === 'self') return map['我'] || this.selfQq();
    const byName = map[String(speakerName ?? '')];
    if (byName) return byName;
    const byId = map[id];
    if (byId) return byId;
    const m = /\(QQ[:：](\d{5,})\)/.exec(String(text ?? ''));
    return m ? m[1] : null;
  }

  /** 被 guard 挡下的，不许静默跳过：写进待核台账，一周看一次。 */
  needsReview(row, reason) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(
        join(this.storeDir, 'needs-review.jsonl'),
        JSON.stringify({
          at: new Date().toISOString(), reason, id: row.id, scene: row.scene,
          speaker: row.speaker, text: String(row.text ?? '').slice(0, 80),
        }) + String.fromCharCode(10),
        'utf8',
      );
    } catch (e) { this.logError('needs-review', e); }
  }

  /**
   * 从一条已发出的出站话里认承诺，落进 promises.jsonl。
   * 只认「未来时间词 + 动作」或「答应/说好/约好」；问句、转述别人、过去时报告都不认。
   * 落账失败只记日志，不影响采集——承诺账不能反过来卡住聊天。
   */
  capturePromise(row) {
    if (!row || row.dir !== 'out') return null;
    if (this.ctx?.cfg?.autoCapturePromises === false) return null;
    // 首次启动可能回填 11-12 之后的历史出站；只收最近 24 小时的，
    // 不然会把几个月前随口说的「明天…」全翻成挂着的新承诺。
    const t = Date.parse(String(row.ts || ''));
    if (!Number.isFinite(t) || Date.now() - t > 24 * 3600 * 1000) return null;
    const cand = extractPromise(row.text);
    if (!cand) return null;
    const r = addPromise({
      storeDir: this.storeDir,
      text: cand.text,
      dueAt: cand.dueAt,
      source: { kind: 'outbound', rawId: row.id, date: row.ts, quote: String(row.text).slice(0, 300) },
      origin: 'auto-outbound',
      conv: '',
    });
    if (r.ok) {
      try {
        appendFileSync(join(this.storeDir, 'promise-capture.log'),
          `${new Date().toISOString()} ${r.promise.id} due=${r.promise.dueAt} text=${cand.text}` + String.fromCharCode(10), 'utf8');
      } catch { /* 日志而已 */ }
      // 明显是自述/过去时、又不是承诺的，落账后立刻清掉，别让它进前缀。
      try {
        const ad = autoDropFalseCaptures({ storeDir: this.storeDir, apply: true, ids: [r.promise.id] });
        if (ad.dropped.length) this.logAction({ action: 'promise-auto-drop', ids: ad.dropped.map((x) => x.id) });
      } catch (e) { this.logError('promise-auto-drop', e); }
      return r.promise;
    }
    return null;
  }

  /**
   * 出站直采（11-12 定）：QQ 世界成功发送后写 data/qq-sent.jsonl。
   * 只追加，不改原文：text 一个字符都不动，失败的不写。
   * 首次从「raw-log 最后一条出站」之后接，补上 11:38 之后缺的口子；之后按字节游标增量。
   */
  captureSent() {
    let buf;
    try { buf = readFileSync(this.sentFile); } catch (e) {
      if (e && e.code !== 'ENOENT') this.logError('sent-read', e);
      return;
    }
    const state = this.loadState() || {};
    // 2026-11-27 01:5x：空转。qq-sent 没有新字节时，原来仍然 readRows() 把 14.7MB 的
    // raw-log 整个解析一遍（只为了建去重用的 known），每 5 秒一次，一天读 250GB。
    // 没有新行就没有东西要去重，直接回去。必须用精确相等：文件被截断时 start > buf.length，
    // 得走下面的重置逻辑重读。
    const prevStart = Number(state.sentCursor);
    if (state.sentBackfill12 === true && Number.isFinite(prevStart) && prevStart === buf.length) return;
    const rows = this.readRows();
    const known = new Set(rows.map((r) => r.key));
    const initialized = Object.prototype.hasOwnProperty.call(state, 'sentCursor');
    let start = Number(state.sentCursor);
    if (!Number.isFinite(start) || start < 0 || start > buf.length) {
      start = 0;
    }
    // 首次只接最后一条出站之后；文件被截断时也按这条兜底，避免整份回灌重复。
    let floorMs = 0;
    // 11-12 一次性回填：19:29 之前的出站没采到（首启游标从文件尾起）。
    // 只回 11-12 零点之后这段，回完置 sentBackfill12，之后不再重复。
    const needBackfill = state.sentBackfill12 !== true;
    if (needBackfill) start = 0;   // 回填要从文件头读，游标已经在缺失段之后了
    if (!initialized || start === 0) {
      for (const r of rows) {
        if (r && r.dir === 'out') {
          const t = Date.parse(String(r.ts || ''));
          if (Number.isFinite(t) && t > floorMs) floorMs = t;
        }
      }
    }
    if (needBackfill) floorMs = 0;   // 回填时不按「最后一条出站」压
    const sinceMs = needBackfill ? Date.parse('2026-11-12T00:00:00+08:00') : 0;
    const chunk = buf.subarray(start).toString('utf8');
    const nl = chunk.lastIndexOf('\n');
    if (nl < 0) return;
    const complete = chunk.slice(0, nl);
    const lines = complete ? complete.split('\n') : [];
    let wrote = 0;
    let skippedFailed = 0;
    let badLines = 0;
    let writeFailed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { this.logError('sent-json', e); badLines++; continue; }
      const ts = Number(rec && rec.ts);
      if (!Number.isFinite(ts)) continue;
      if (floorMs && ts <= floorMs) continue;
      if (sinceMs && ts < sinceMs) continue;
      const text = String(rec.text ?? '');   // 原样，不 trim、不拆句、不改标点
      if (!text) continue;

      // 11-12 定：失败发送过滤。ok/total 是 QQ 世界按分段写进来的结果；
      // 老流水没有这两个字段，按已发送处理，不追溯。
      // 只压「一段都没成」和「部分成」两种：部分成还把整条 text 记进去，记的就是她没说过的话。
      const okN = Number(rec.ok);
      const totalN = Number(rec.total);
      // planned 才是计划段数：限速 break 在 total++ 之前，光比 ok/total 会把没发出去的当成功。老流水没有 planned，退回 total。
      const plannedN = Number.isFinite(Number(rec.planned)) ? Number(rec.planned) : totalN;
      if (Number.isFinite(okN) && Number.isFinite(plannedN) && okN < plannedN) { skippedFailed++; continue; }
      const key = 'qqsent:' + ts + ':' + createHash('sha256').update(text).digest('hex').slice(0, 16);
      if (known.has(key)) continue;
      // 同一条出站可能先从 fact-store 进来（memory 世界也会写她说），
      // 十分钟内同文同向只留一条，避免 dir=out 重复。
      // 11-13 00:1x：比对前先规整空白。live.md 那边把换行压成两个空格，
      // 严格相等会把同一条判成两条，于是每次重启都会重复落一遍。
      const normT = (v) => String(v ?? '').replace(/^（她说）/, '').replace(/\s+/g, ' ').trim();
      // normT 只在回填去重时用：吃掉 live 压换行造成的重复；实时两条真消息仍按原文严格比。
      const plain = needBackfill ? normT(text) : text.replace(/^（她说）/, '');
      const dup = rows.some((r) => {
        if (!r || r.dir !== 'out') return false;
        if ((needBackfill ? normT(r.text) : String(r.text ?? '').replace(/^（她说）/, '')) !== plain) return false;
        const t = Date.parse(String(r.ts || ''));
        return Number.isFinite(t) && Math.abs(t - ts) <= 10 * 60 * 1000;
      });
      if (dup) continue;
      const conv = String(rec.conv || '');
      const scene = conv.startsWith('group:') ? 'group' : conv.startsWith('private:') ? 'private' : 'non';
      const iso = new Date(ts).toISOString();
      const row = {
        ts: iso, tsUtc: iso, tsKind: 'occurred',
        dir: 'out', scene,
        speaker: { id: 'self', name: '我' },
        text, src: 'qq-sent', source: 'quote',
        key, id: this.nextId(rows), turn: 'collect',
        deriveVia: 'outbound',
      };
      const sq = this.selfQq();
      if (sq) row.speakerKey = sq;
      try {
        mkdirSync(this.storeDir, { recursive: true });
        appendFileSync(this.rawFile, JSON.stringify(row) + String.fromCharCode(10), 'utf8');
        this._rawIndex = null;
        known.add(key); rows.push(row); wrote++;
        // 2026-11-22 18:4x：出站话里认得出的新承诺，直接落进承诺账。
        // 只认「未来时间词 + 动作」或「答应/说好/约好」；认不出不硬抓。
        try { this.capturePromise(row); } catch (e) { this.logError('capturePromise', e); }
        // 2026-11-23：回声账。只记私聊出站，配下一条入站；不判断对错。
        try { recordOutboundEcho({ storeDir: this.storeDir, rawId: row.id, conv, text, at: iso }); }
        catch (e) { this.logError('echo-out', e); }
      } catch (e) { this.logError('sent-append', e); writeFailed = true; badLines++; }
    }
    const consumed = start + Buffer.byteLength(chunk.slice(0, nl + 1), 'utf8');
    // 写 raw 失败绝不推进游标：否则这条出站就永久丢了，下一次也不会重试。
    this.saveState({
      ...state,
      sentCursor: writeFailed ? start : consumed,
      sentAt: new Date().toISOString(),
      sentWritten: Number(state.sentWritten || 0) + wrote,
      ...(needBackfill && !writeFailed ? { sentBackfill12: true } : {}),
    });
    if (wrote || skippedFailed || writeFailed) {
      try {
        appendFileSync(join(this.storeDir, 'collector-outbound.log'),
          `${new Date().toISOString()} first=${!initialized} wrote=${wrote} failedSkipped=${skippedFailed} writeFailed=${writeFailed} floor=${floorMs || 'none'} cursor=${consumed}` + String.fromCharCode(10), 'utf8');
      } catch (e) { this.logError('sent-log', e); }
    }
  }

  /**
   * 入站直采（2026-11-21 21:0x 定）：自己读宿主事件流，不等 memory 世界写 fact-store。
   * 只认真人入站（isInboundUser），按游标增量；首次只锚定，不回头灌历史。
   * 去重两道：平台消息号相同 → 跳过；同向同文且相差 10 分钟内 → 跳过。
   * （memory 世界还开着时它那条路也在写，这两道就是给它留的。）
   */
  captureInbound() {
    const host = this.host;
    const store = host && host.store;
    if (!store || typeof store.range !== 'function') return;
    if (typeof host.isPaused === 'function' && host.isPaused() === true) return;
    const state = this.loadState() || {};
    const to = Number(typeof store.latestCursor === 'function' ? store.latestCursor() : NaN);
    if (!Number.isFinite(to) || to <= 0) return;
    if (!Object.prototype.hasOwnProperty.call(state, 'evCursor')) {
      // 首次只锚定：历史已经由 fact-store / live-backfill 进去过，重灌只会造重复。
      this.saveState({ ...state, evCursor: to, evAt: new Date().toISOString(), evNote: 'anchored; no backfill' });
      return;
    }
    const from = Number(state.evCursor);
    if (!Number.isFinite(from) || from < 0 || from > to) {
      this.logError('captureInbound', new Error('游标不合法 from=' + state.evCursor + ' to=' + to));
      this.saveState({ ...state, evCursor: to, evAt: new Date().toISOString() });
      return;
    }
    if (to <= from) return;
    let events;
    try { events = store.range({ fromCursor: from + 1, toCursor: to }) || []; }
    catch (e) { this.logError('captureInbound:range', e); return; }
    const rows = this.readRows();
    const knownMids = new Set(rows.map((r) => r && r.mid).filter(Boolean).map(String));
    const normT = (v) => stripReplayScaffold(String(v ?? '')).replace(/\s+/g, ' ').trim();
    const inRows = rows.filter((r) => r && r.dir === 'in');
    let wrote = 0;
    let skippedDup = 0;
    let writeFailed = false;
    for (const e of events) {
      try {
        if (!isInboundUser(e)) continue;
        const text = cleanCaptureText(e.text ?? '');
        if (!text) continue;
        const meta = e.meta || {};
        const conv = String(meta.conv || '');
        const minCapture = conv.startsWith('private:') ? 1 : 2;
        if (text.length < minCapture) continue;
        const mid = String(meta.platformMessageId || meta.messageId || '').trim();
        let ms = NaN;
        if (typeof e.ts === 'number' && Number.isFinite(e.ts)) ms = e.ts > 1e12 ? e.ts : e.ts * 1000;
        else ms = Date.parse(String(e.ts || ''));
        const tsKind = Number.isFinite(ms) ? 'occurred' : 'collected';
        if (!Number.isFinite(ms)) ms = Date.now();
        const iso = new Date(ms).toISOString();
        if (mid && knownMids.has(mid)) { skippedDup++; continue; }
        // 有平台消息号时只认消息号；正文去重只给「没有号」的旧路径兜底，
        // 且窗口压到 5 秒内（同一事件重放），避免把用户 5 分钟内的第二次「同意」吃掉。
        const dup = !mid && inRows.some((r) => {
          if (normT(r.text) !== normT(text)) return false;
          const t = Date.parse(String(r.ts || ''));
          return Number.isFinite(t) && Math.abs(t - ms) <= 5 * 1000;
        });
        if (dup) { skippedDup++; continue; }
        // 说者：先按 QQ 号，再用 aliases 认规范名；都没有就留昵称原样，别猜。
        let spId = String(meta.user ?? '').trim();
        if (!spId && String(e.senderKey ?? '').startsWith('private:')) {
          // 私聊补投没带 meta.user；senderKey 就是 private:<主人QQ>。
          // 只对 private 兜底，群聊不猜谁说的。
          const m = String(e.senderKey).match(/^private:(\d{4,})$/);
          if (m) spId = m[1];
        }
        if (!spId) {
          const m = String(meta.sender ?? '').match(/QQ[:：]\s*(\d{4,})/);
          if (m) spId = m[1];
        }
        let spName = (spId && this.nameOfQq(spId)) || '';
        if (!spName) spName = String(meta.sender || '').replace(/[（(]\s*QQ[:：]\d+\s*[)）]/g, '').trim();
        if (!spName) spName = spId || '未知';
        let scene = conv.startsWith('group:') ? 'group' : conv.startsWith('private:') ? 'private' : 'desktop';
        scene = this.deriveScene(text, scene);
        const nonSpeaker = this.isNonSpeaker(spId || 'unknown', scene);
        if (nonSpeaker) scene = 'non';
        if (!SCENE_ENUM.has(scene)) scene = 'non';
        const speakerKey = nonSpeaker ? null : this.deriveSpeakerKey(spId || 'unknown', spName, text);
        const row = {
          ts: iso, tsUtc: iso, tsKind,
          dir: 'in', scene,
          speaker: { id: speakerKey || spId || 'unknown', name: spName },
          text, src: 'event', source: 'quote',
          key: 'event:' + (mid || (ms + ':' + createHash('sha256').update(text).digest('hex').slice(0, 12))),
          id: this.nextId(rows), turn: 'collect',
          deriveVia: 'inbound',
          ...(conv ? { conv } : {}),
          ...(mid ? { mid } : {}),
          ...(nonSpeaker ? { nonSpeaker: true } : {}),
          ...(speakerKey ? { speakerKey } : {}),
        };
        try {
          appendFileSync(this.rawFile, JSON.stringify(row) + String.fromCharCode(10), 'utf8');
        } catch (e) {
          this.logError('inbound-append', e);
          writeFailed = true;
          break;
        }
        this._rawIndex = null;
        rows.push(row); inRows.push(row);
        if (mid) knownMids.add(mid);
        try { pairEcho({ storeDir: this.storeDir, rawId: row.id, conv, text, at: iso }); }
        catch (e) { this.logError('echo-in', e); }
        wrote++;
      } catch (e2) {
        // 单条脏事件不许卡住整轮：记下来继续，游标照走。
        this.logError('captureInbound:event', e2);
      }
    }
    // 写 raw 失败绝不推进 evCursor：否则这条入站就永久丢了，下一次也不会重试。
    this.saveState({ ...state, evCursor: writeFailed ? from : to, evAt: new Date().toISOString(), evWritten: Number(state.evWritten || 0) + wrote });
    if (wrote || skippedDup || writeFailed) {
      try {
        appendFileSync(join(this.storeDir, 'collector-inbound.log'),
          new Date().toISOString() + ' wrote=' + wrote + ' dup=' + skippedDup + ' writeFailed=' + writeFailed + ' from=' + from + ' to=' + to + String.fromCharCode(10), 'utf8');
      } catch (e) { /* 日志写不了不拦事 */ }
    }
  }

  logAction(rec) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(join(this.storeDir, 'action-log.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...rec }) + String.fromCharCode(10), 'utf8');
    } catch (e) { this.logError('action-log', e); }
  }

  /** 自己的钟：到点 push 一条内部事件，叫醒自己；不经过 QQ，也不等谁开口。 */
  async fireDueJobs(nowInput = new Date()) {
    if (!this.host || this._firingJobs) return;
    if (this.ctx?.cfg?.selfJobsEnabled === false) return;
    this._firingJobs = true;
    try {
      const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
      const seeded = ensureDefaultJobs(this.storeDir, now);
      if (seeded?.seeded) this.logAction({ action: 'job-seed', jobId: seeded.job?.id, at: now.toISOString() });
      const due = dueJobs(this.storeDir, now, undefined, undefined,
        (job, e) => this.logError('job-due:' + (job && job.id || 'unknown'), e));
      for (const item of due) {
        const { job, scheduled, missed } = item;
        const missedText = missed.count > 1
          ? `—— 补投：原定 ${formatAt(scheduled)}，错过了 ${missed.capped ? `${missed.count} 拍以上` : `${missed.count} 拍`}`
          : `—— 原定 ${formatAt(scheduled)}`;
        const fullText = [
          job.text,
          '',
          `—— job ${job.id} · ${scheduleText(job)} · ${missedText}`,
        ].join(String.fromCharCode(10));
        // P2 静默唤醒墓碑（借 dsh-proactive）：自审到点只推一行可执行的指路，
        // 完整清单留在 xi_recap/xi_job list；其它 job 仍按原文推。
        const isSelfReview = /^【xi 自审/.test(String(job.text || ''));
        const tombstone = isSelfReview && this.ctx?.cfg?.jobTombstone !== false;
        const text = tombstone
          ? `[xi.job.due ${job.id} ${formatAt(scheduled).slice(-5)}] 自审到点：先 xi_recap 看四本账（承诺/候选/缺口/冲突/回声），只做 xi 内动作，不发 QQ。${missed.count > 1 ? '（补投）' : ''}`
          : fullText;
        const before = JSON.parse(JSON.stringify(job));
        const scheduledIso = scheduled.toISOString();
        const already = job.lastDeliveredScheduled === scheduledIso
          || (Array.isArray(job.deliveredScheduled) && job.deliveredScheduled.includes(scheduledIso));
        if (already) {
          try { markJobSkipped(this.storeDir, job, scheduled, now); } catch (e) { this.logError('job-skip:' + job.id, e); }
          this.logAction({ action: 'job-skip-dup', jobId: job.id, scheduled: scheduledIso, at: now.toISOString() });
          continue;
        }
        try {
          // 先落“已响”再投递：投递失败能 restore，宁可不发也不重复刷。
          const marked = markJobFired(this.storeDir, job, scheduled, now);
          if (!marked) throw new Error(`markJobFired 找不到 ${job.id}（jobs.json 可能被并发改写）`);
        } catch (e) {
          this.logError('job-mark:' + job.id, e);
          this.logAction({ action: 'job-mark-failed', jobId: job.id, error: String(e && e.message || e), at: now.toISOString() });
          continue;
        }
        try {
          // 空闲时用 preempt：让「钟」真的起一轮；忙时用 flush，等本轮收尾再接。
          const trigger = this._phase === 'idle' ? 'preempt' : 'flush';
          await this.host.pushEvent({
            type: 'xi.job.due',
            ts: now.toISOString(),
            source: 'xi-memory',
            origin: 'internal',
            senderKey: 'xi-memory',
            text,
          }, { trigger });
          this.logAction({
            action: 'job-fire', jobId: job.id, scheduled: scheduled.toISOString(),
            missed: missed.count, capped: missed.capped, trigger, at: now.toISOString(),
            tombstone, fullBytes: Buffer.byteLength(fullText, 'utf8'), pushedBytes: Buffer.byteLength(text, 'utf8'),
          });
        } catch (e) {
          try { restoreJob(this.storeDir, before); } catch (e2) { this.logError('job-restore:' + job.id, e2); }
          this.logError('job-fire:' + job.id, e);
          this.logAction({ action: 'job-fire-failed', jobId: job.id, error: String(e && e.message || e), at: now.toISOString() });
        }
      }
    } catch (e) {
      this.logError('fireDueJobs', e);
    } finally {
      this._firingJobs = false;
    }
  }

  scanPreferences() {
    if (this.ctx && this.ctx.cfg && this.ctx.cfg.autoPreferences === false) return;
    const now = Date.now();
    if (now - this._lastPrefScanAt < 5 * 60 * 1000) return;
    this._lastPrefScanAt = now;
    try {
      const r = autoPreferenceScan({ storeDir: this.storeDir });
      if (r && r.added) {
        this.logAction({ action: 'preference-auto', added: r.added, ids: (r.candidates || []).map((c) => c.id), at: new Date(now).toISOString() });
      }
    } catch (e) {
      this.logError('preference-auto', e);
    }
  }

  autoPromoteFailures() {
    if (this.ctx && this.ctx.cfg && this.ctx.cfg.autoPromoteFailures === false) return;
    const now = Date.now();
    if (now - this._lastAutoPromoteAt < 10 * 60 * 1000) return;
    this._lastAutoPromoteAt = now;
    try {
      const r = autoPromoteFailureLessons({ storeDir: this.storeDir, now: new Date(now) });
      if (r && r.promoted) this.logAction({ action: 'lesson-auto-promote', candidateId: r.candidateId, lessonId: r.lesson?.id || '', at: new Date(now).toISOString() });
    } catch (e) {
      this.logError('lesson-auto-promote', e);
    }
  }

  tick() {
    void this.fireDueJobs();
    try { this.scanPreferences(); } catch (e) { this.logError('preference-auto(tick)', e); }
    try { this.autoPromoteFailures(); } catch (e) { this.logError('lesson-auto-promote(tick)', e); }
    try { this.captureInbound(); } catch (e) { this.logError('captureInbound(tick)', e); }
    if (Date.now() - this._lastEchoSweepAt >= 60_000) {
      this._lastEchoSweepAt = Date.now();
      try { sweepEcho({ storeDir: this.storeDir }); } catch (e) { this.logError('echo-sweep', e); }
    }
    try { this.mirrorMsgIds(); } catch (e) { this.logError('msgid', e); }
    let state = this.loadState();
    if (!state || !state.anchors) {
      // 首次：只锚定，不写。也不回头补历史。
      const scopes = this.readFactStore();
      const anchors = {};
      for (const [scope, list] of Object.entries(scopes)) {
        if (!INGEST_SCOPES(scope) || !Array.isArray(list)) continue;
        anchors[scope] = list.reduce((m, e) => Math.max(m, Number(e && e.createdAt) || 0), 0);
      }
      this.saveState({ anchors, at: new Date().toISOString(), note: 'anchored; no backfill' });
      try { this.captureSent(); } catch (e) { this.logError('sent(first)', e); }
      return;
    }
    try { this.captureSent(); } catch (e) { this.logError('sent(tick)', e); }
    state = this.loadState() || state;
    const scopes = this.readFactStore();
    const fresh = this.pickNew(scopes, state.anchors);
    if (!fresh.length) { this.saveState({ ...state, at: new Date().toISOString() }); return; }
    const rows = this.readRows();
    const known = new Set(rows.map((r) => r.key));
    let written = 0;
    const byScope = new Map();
    for (const [scope, list] of Object.entries(scopes)) if (Array.isArray(list)) byScope.set(scope, list);
    for (const item of fresh) {
      // 同 scope、同一小时、相邻两条差 >= 5 分钟 → 记一笔缺口（只在处理新条目时记，不重复报）
      const list = byScope.get(item.scope) || [];
      const sorted = [...list].filter((e) => Number.isFinite(Number(e && e.createdAt))).sort((a, b) => a.createdAt - b.createdAt);
      const idx = sorted.findIndex((e) => Number(e.createdAt) === item.createdAt && (e.hash ? e.hash === item.entry.hash : true));
      if (idx > 0) {
        const prev = Number(sorted[idx - 1].createdAt);
        const sameHour = Math.floor(prev / 3600) === Math.floor(item.createdAt / 3600);
        if (item.createdAt - prev >= 300 && sameHour) this.logGap(item.scope, prev, item.createdAt);
      }
      const rec = this.toRecord(item);
      if (!rec) continue;
      // 整条只是个引用块（没有正文）：不是谁说的话，收进来只会污染检索。
      if (rec.drop === 'quote-only') { this.needsReview({ id: 'pending', scope: item.scope, text: rec.quote }, 'quote-only'); continue; }
      const key = `factstore:${item.entry.hash || item.createdAt}`;
      if (known.has(key)) continue;
      // 2026-11-12 20:4x（方案二）：出站只留 qq-sent 直采这一条路。
      // memory 世界的 captureSent 读的是同一个 qq-sent.jsonl，写进 fact-store 再绕回来，
      // 途中换行被压成空格（qq-sent 留 \n\n，fact-store 是单个空格），逐字比永远比不中。
      // 修比对治不了「一句话收两遍」；她说层仍由 memory 世界自己写，这里只是不再往 raw-log 收。
      if (rec.dir === 'out') continue;
      const id = this.nextId(rows);
      let scene = this.deriveScene(rec.text, rec.scene);
      const nonSpeaker = this.isNonSpeaker(rec.speakerId, scene);
      if (nonSpeaker) scene = 'non'; // 非聊天行不许挂聊天的 scene
      if (!SCENE_ENUM.has(scene)) {
        this.needsReview({ id, scene, speaker: { id: rec.speakerId, name: rec.speakerName }, text: rec.text }, 'scene-not-in-enum');
        scene = 'non';
      }
      const speakerKey = nonSpeaker ? null : this.deriveSpeakerKey(rec.speakerId, rec.speakerName, rec.text);
      const tsIso = new Date(item.createdAt * 1000).toISOString();
      const row = {
        ts: tsIso,
        tsUtc: tsIso,
        tsKind: 'collected',
        dir: rec.dir, scene,
        speaker: { id: rec.speakerId, name: rec.speakerName },
        text: rec.text, src: 'factstore', source: 'quote',
        // 2026-11-21 01:5x：入站原话行带上平台消息号（memory 世界 11-21 起才写进 fact-store）。
        // 历史行没有 mid，不补、不猜——宁可缺，不给假号。
        ...(item.entry && item.entry.mid ? { mid: String(item.entry.mid) } : {}),
        ...(rec.quote ? { quote: rec.quote } : {}),
        key, id, turn: 'collect',
        deriveVia: 'write',
      };
      if (nonSpeaker) row.nonSpeaker = true;
      else if (speakerKey) row.speakerKey = speakerKey;
      else this.needsReview(row, 'no-speakerKey');
      try {
        mkdirSync(this.storeDir, { recursive: true });
        appendFileSync(this.rawFile, JSON.stringify(row) + String.fromCharCode(10), 'utf8');
        this._rawIndex = null;   // 新行进来，occurredOf 的索引要重建
        known.add(key); rows.push(row); written++;
      } catch (e) { this.logError('append', e); }
    }
    this.saveState({ ...state, at: new Date().toISOString(), lastWritten: written });
  }

  async start(host) {
    this.host = host;
    // 启动时清一遍历史误抓；之后新出站由 capturePromise 当场清。
    try {
      const ad = autoDropFalseCaptures({ storeDir: this.storeDir, apply: true });
      if (ad.dropped.length) this.logAction({ action: 'promise-auto-drop', ids: ad.dropped.map((x) => x.id) });
    } catch (e) { this.logError('promise-auto-drop(start)', e); }
    try { this.tick(); } catch (e) { this.logError('tick(start)', e); }
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.logError('tick', e); } }, POLL_MS);
    this.timer.unref?.();
  }
  onRunPhase(phase) {
    this._phase = (phase && phase.state) || 'idle';
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  remember(args) {
    const text = String(args.text ?? '').trim();
    if (!text) return '没写：text 是空的';
    // 2026-11-25 01:0x 压测：10 万字的 text 也照单全收，一行原话把 raw-log 撑到十几 MB，
    // 之后每次 ask 都要 parse 这一行。原话不该有这么大，宁可拒，也不悄悄截断（截了就失真）。
    if (text.length > 20000) return `没写：text 有 ${text.length} 字，一条原话不该这么长；拆成几条，或只存关键的那段。`;
    const speakerNameRaw = String(args.speaker ?? '主人').trim() || '主人';
    // 只认号：昵称先查 aliases，查不到才退回昵称本身；我固定 self。
    let speakerId = speakerNameRaw;
    if (speakerNameRaw === '我') speakerId = 'self';
    else {
      const byName = this.qqOfName(speakerNameRaw);
      if (byName) speakerId = byName;
    }
    const sceneRaw = String(args.scene ?? 'private').trim() || 'private';
    // scene 也是派生字段（我 11-10 18:4x 定）：正文前缀说了算，值不在枚举里就写待核
    let scene = this.deriveScene(text, sceneRaw);
    const nonSpeaker = this.isNonSpeaker(speakerId, scene);
    if (nonSpeaker) scene = 'non';
    let sceneNote = '';
    if (!SCENE_ENUM.has(scene)) {
      // 2026-11-25 01:0x：乱给的 scene 原先静默改成 non，回执只说「记下了 r0xxxxx」，
      // 调用方以为记在了 private 里。降级可以说，但得让人看见。
      sceneNote = `（scene「${String(scene).slice(0, 20)}」不认识，按 non 记的，已进待审）`;
      this.needsReview({ id: 'pending', scene, speaker: { id: speakerId, name: speakerNameRaw }, text }, 'scene-not-in-enum');
      scene = 'non';
    }
    const conv = String(args.conv ?? '').trim() || (scene.startsWith('group') ? scene : 'private:unknown');
    const messageId = String(args.message_id ?? '').trim() || null;
    const TRIGGERS = ['at', 'name', 'reply', 'self', 'context'];
    let trigger = String(args.trigger ?? '').trim();
    if (trigger && !TRIGGERS.includes(trigger)) return `没写：trigger 只能是 ${TRIGGERS.join(' / ')}`;
    if (!trigger) trigger = 'self';
    // 当场标（11-10 00:23）：写进来的时候就把档定下，别回头猜
    const 档 = String(args['档'] ?? args.tag ?? '').trim();
    const TAG = ['规则', '事实', '计划', '不存', '拿不准'];
    if (档 && !TAG.includes(档)) return `没写：档只能是 ${TAG.join(' / ')}`;
    const 最终档 = 档 || '待标';   // 没传档 → 进待标池，谁也别替她决定存还是丢
    // 档=不存 就是真不存（我 11-10 19:09 指出：写着「不存」却存了，这参数等于垃圾）
    if (!档) { /* 待标：照写，交给后面判 */ }
    else if (最终档 === '不存') return '没写：档=不存，这条不进库';
    // 入库只认 UTC。ts 认不出时不抛（2026-11-25 见：new Date('not-a-date').toISOString() 直接 RangeError，
    // 整条 remember_raw 崩在工具层）——退回现在，并在回执里说明，免得这条原话悄悄丢了。
    let ts = null;
    let tsNote = '';
    const tsRaw = args.ts;
    if (tsRaw !== undefined && tsRaw !== null && String(tsRaw).trim()) {
      const s = String(tsRaw).trim();
      const d = new Date(s);
      const y = d.getUTCFullYear();
      if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(d.getTime()) && y >= 2000 && y <= 2100) ts = d.toISOString();
      else tsNote = `（ts「${s.slice(0, 40)}」认不出，按现在记的）`;
    }
    if (!ts) ts = new Date().toISOString();
    const rows = this.readRows();
    // 2026-11-25 01:0x：工具声明说 message_id「用于去重」，可写入层根本没查——同一条消息
    // 记两遍就落两行，ask_raw 的候选里同一句话出现两次。这里补上。
    if (messageId) {
      const dup = rows.find((r) => r && r.messageId === messageId);
      if (dup) return `没写：这条消息（message_id=${messageId}）已经在库里了（${dup.id}），不重复记。`;
    }
    const id = this.nextId(rows);
    const speakerKey = nonSpeaker ? null : this.deriveSpeakerKey(speakerId, speakerNameRaw, text);
    const row = {
      ts, tsUtc: ts, tsKind: 'collected', dir: trigger === 'self' ? 'out' : 'in', scene,
      speaker: { id: speakerKey || speakerId, name: speakerNameRaw },
      text, src: 'tool', source: 'quote', key: 'tool:' + id, id, turn: 'remember',
      conv, ...(messageId ? { messageId } : {}), trigger, ['档']: 最终档,
      deriveVia: 'write',
      ...(nonSpeaker ? { nonSpeaker: true } : {}),
      ...(speakerKey ? { speakerKey } : {}),
    };
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(this.rawFile, JSON.stringify(row) + String.fromCharCode(10), 'utf8');
      this._rawIndex = null;
      return `记下了 ${id}${tsNote}${sceneNote}`;
    } catch (e) {
      this.logError('remember', e);
      return '没写成：' + String(e).slice(0, 80);
    }
  }

  /** 读 ask-scope.json（开关/版本/三类）。读不到就返回 null → ask 拒答。 */
  askScope() {
    try { return JSON.parse(readFileSync(join(this.storeDir, 'ask-scope.json'), 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT') this.logError('askScope', e); return null; }
  }

  /** 按三类认类别：名字 / 号 / 事实。认不出返回 null。 */
  classifyScope(q) {
    // 规则类（近似词表，真判据是「会不会随他当天情况变」）。
    // 数据里规则槽已统一成 规矩/底线/权限；问句常分不清这三类，进规则层后一起找。
    // 主语是他/她/别人 → 问的是对别人的判断，不往规则层送；但「我该干什么」问的是自己。
    // 11-14：他/她 当宾语时不算「在问别人」（「下音轨要不要问他」「跟他说什么」都被误判过）
    const qObj = String(q).replace(/(问|告诉|跟|和|对|让|给|找|等)他/g, '').replace(/(问|告诉|跟|和|对|让|给|找|等)她/g, '');
    const aboutOther = /他|她|别人/.test(qObj) && !/我该|我应|我要不要|我怎么办/.test(q);
    // 11-14 20:31：「半夜要不要催他睡」被判成事实、走事实层被主体筛挡掉，而「…催你睡」走规则层正常。
    // 差的是那个「他」。判类看的是「这句在问规矩还是问人」，不是「这句里有没有第三人称」——
    // 带「要不要/该不该」这类问法的句子，代词只影响主体归谁，不该影响类别。
    const isModalAsk = /要不要|该不该|能不能|可不可以|用不用|需不需要|许不许|准不准|行不行/;
    // 11-14：「要不要 / 用不用 / 需不需要」原先只在 attr-questions.json 里有，那份表没人读，这里补上
    if ((!aboutOther || isModalAsk.test(q)) && /权限|能不能|可不可以|该不该|要不要|用不用|需不需要|该干什么|该做什么|怎么办|必须|一律|不许|准不准|条件|规矩|约定|底线|要求|说好的/.test(q)) return '规矩';
    // 11-18 21:5x（我点头，只改这一处）：疑问式先剥再判。
    // 逼出这条的是「他给我的名字是什么」——去掉「是什么」判得出「身份」，带上就判不出。
    // 只剥**句尾的疑问式**，不动「该干什么 / 做什么」这类（那是规矩的判断依据，剥了会误判）。
    const q2 = String(q).replace(/(是什么|是啥|叫什么|是多少|是哪天|是哪个|是谁|几个号)\s*$/, '');
    // 身份四槽（名字/称呼/关系/号）已在数据里并成「身份」；分类器还按旧词找就一条都找不到
    if (/名字|真名|实名|叫什么|叫啥|怎么叫|称呼|关系|谁取的|哪来的/.test(q2)) return '身份';
    if (/暗号|代号|番号/.test(q2)) return null;          // 暗号不是号码
    if (/号|QQ|号码/.test(q2)) return '身份';
    if (/模型|装了什么|用的什么|配置|哪台电脑|说过|喊我|叫我|怎么喊/.test(q2)) return '事实';
    // 11-15 20:2x：「你说等一下的时候，我应该等多久再问」认不出类别，默认掉进事实层，
    // 而 f0174 是规矩条，进不了事实层的候选（inScope 按同槽筛）。问的是我自己该按什么做 = 规矩。
    // 只兜最后这一层，前面已经判出类别的句子一条都不碰。
    if (/我(?:应该|应当|该)/.test(q)) return '规矩';
    return null;
  }

  /** 多条值的事实（如换房三条件）：先答内容，再说凭据。 */
  findValues(q) {
    try {
      const facts = readFileSync(join(this.storeDir, 'facts.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
      for (const f of facts) {
        if (!Array.isArray(f.values) || !f.values.length) continue;
        if (f.supersededBy || f['合并到']) continue;
        if ((f.answerFor || []).some((k) => q.includes(k))) return f;
      }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('findValues', e); }
    return null;
  }

  /**
   * 跨槽兜底（11-11 18:5x）：answerFor 命中就算它的问话，不按分类器划的槽找。
   * 只认带出处的非规则条；命中多条这里不挑，返回 null 交回原路。
   */
  askCrossSlot(q, live) {
    const qq = String(q).replace(/\s+/g, '');
    const scored = live.filter((f) => !['规矩', '底线', '权限'].includes(String(f.slot))
      && f.sourceNote && f.sourceNote.file && f.sourceNote.lines)
      .map((f) => {
        const keys = (f.answerFor || []).filter((k) => k && qq.includes(String(k)));
        if (!keys.length) return null;
        // 11-19 20:4x 我：多命中时挑「点名点得最早」的那条 —— 主体写在前面就该归它。
        const at = Math.min(...keys.map((k) => qq.indexOf(String(k))));
        const len = Math.max(...keys.map((k) => String(k).length));
        return { f, at, len };
      })
      .filter(Boolean);
    if (!scored.length) return null;
    scored.sort((a, b) => a.at - b.at || b.len - a.len);
    if (scored.length > 1 && scored[0].at === scored[1].at && scored[0].len === scored[1].len) return null;
    const f = scored[0].f;
    const src = this.verifySource(f);
    if (!src) return null;
    return { result: 'answered', id: f.id, ...this.speakFact(f), file: src.file, lines: src.lines, candidates: 1, basis: 'answerFor-cross-slot', fact: f };
  }

  /** 查事实：只认带出处的（sourceNote 有 file+lines），其余一律不许答。 */
  /**
   * 出口那一道（我 11-14 19:44 定）：mode 不是 quoted 的，不许当原话端出去。
   * 做三件事：剥掉正文两端可能有的引号、标一个「引文：原话|改写」、每次端出去记一行账。
   */
  speakFact(f) {
    const quoted = !!(f && f.mode === 'quoted');
    // 成对的引号表（我 11-14 19:57）：一对一地剥，且**两端都配上**才剥。
    // 上一版写成单字符串表，漏了闭引号，「「…」」只剥掉开头那半个 —— 剥这类东西最容易漏半边。
    const PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']];
    let text = String((f && f.text) || '');
    if (!quoted) {
      for (;;) {
        const pair = PAIRS.find(([o, c]) => text.startsWith(o) && text.endsWith(c) && text.length > o.length + c.length);
        if (!pair) break;
        text = text.slice(pair[0].length, text.length - pair[1].length).trim();
      }
    }
    // mode 现在是写库时算出来的（facts.ts modeOfInput），正常不该缺。
    // 缺了就是代码不一致 —— 兜底照剥，但必须响一声、并进待办队列，不许只写日志了事。
    let warn = null;
    if (f && !f.mode) {
      warn = 'mode-missing';
      try {
        appendFileSync(join(this.storeDir, 'mode-missing.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), id: (f && f.id) || null, text: text.slice(0, 60) }) + String.fromCharCode(10), 'utf8');
      } catch (e) { /* 队列写不进，日志那条还得写 */ }
    }
    try {
      appendFileSync(join(this.storeDir, 'exit-quote.log'),
        JSON.stringify({ at: new Date().toISOString(), id: (f && f.id) || null, mode: (f && f.mode) || null, quoted, ...(warn ? { warn } : {}) }) + String.fromCharCode(10), 'utf8');
    } catch (e) { /* 账记不上不许挡出口 */ }
    // 三档引文（我 11-14 22:09 定）：原话=逐字在锚行里；改写=有出处行、正文是概括；
    // 转述=状态是「没源」，或锚行说话人不是 subject 本人 —— 那种情况下 sourceNote 指的那一行
    // 本来就不算出处，打出来等于拿它冒充依据。
    const 引文类 = this.quoteClassOf(f);
    const 转述 = 引文类 === '转述';
    const 是引文 = 引文类 === '引文';
    let out = text;
    if (转述) out = '这条我没找到原话，下面是我当时的转述：' + text;
    else if (是引文) out = '这句是从转贴行里抄的，字对得上，但记的是转贴那天、不是当时说的那一刻：' + text;
    // 答了现行条，顺手把链上那句带出来（我 11-14 22:09：只甩一条过期的，他会当成现在还在执行）
    const 前身 = this.predecessorsOf(f);
    return {
      text: out,
      引文: 引文类,
      ...(转述 ? { 不给出处: true } : {}),
      ...(f && f['身份未解析'] ? { 身份: '这条是谁说的还不确定（说话人还没解析出来）' } : {}),
      // 合成来源（我 11-14 22:53）：压根没有那个人。不许默认落成「主人说的」——
      // 没说话人的话被默认归到主人头上，比找不到更糟。
      ...(f && f['来源类型'] ? { 说话人: '这条不是谁说的话，是种子数据或笔记里的' } : {}),
      // 设置锚单开一轴（我 11-14 22:55）：它不是谁说的话，而且**会变**。
      // 出口不许说「就是这样」，只能说「当时读到的是这个」。
      ...(f && f['设置锚']
        ? {
            设置: (() => {
              const a = f['设置锚'] || {};
              const 记的 = a['读到的mtime'] || null;
              // 我 11-14 23:09：出口不读文件内容，只 stat 一次 mtime —— 文件没被写过，里面的值就不会变。
              let 现在 = null;
              // 库里 读到的mtime 是**本地时间**（2026-10-24T01:39:32 这种），
              // 这里也必须按本地格式化。第一版用 toISOString() 是 UTC，整整差 8 小时，
              // 会让每一条设置都误报「改过了」—— 差一天和差 8 小时长得一样，只有真跑才看得见。
              const 本地 = (d) => {
                const p2 = (n) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
              };
              try { 现在 = 本地(new Date(statSync(a['文件']).mtimeMs)); } catch (e) { 现在 = null; }
              const 改过 = !!(现在 && 记的 && 现在 !== 记的);
              return {
                键: a['键'],
                当时读到: a['值'],
                读到于: 记的,
                会变: true,
                ...(现在 ? { 文件现在mtime: 现在 } : { 文件读不到: true }),
                ...(改过 ? { 改过了: true } : {}),
                说明: 改过
                  ? '这条是配置值，不是谁说的；文件在那之后被改过，问到的可能已经不是这个了'
                  : '这条是配置值，不是谁说的；配置改了它就会变，问到的可能是旧的',
              };
            })(),
          }
        : {}),
      ...(前身.length ? { 前身: 前身[0].text } : {}),
      ...(warn ? { warn } : {}),
    };
  }

  /**
   * 引文三档（我 11-14 22:09）：原话=逐字在锚行里；改写=有出处行、正文是概括；
   * 转述=状态是「没源」，或锚行说话人不是 subject 本人——那时 sourceNote 那一行不算出处。
   * 出口只读数据里的值，不另立一份状态名单。
   */
  quoteClassOf(f) {
    if (!f) return '改写';
    const 状态 = String(f['状态'] || '').trim();
    if (状态 === '没源') return '转述';
    // 锚本来就不在 raw-log 里的三种（设置/笔记/自述），说话人这一栏没有意义，不拿它判声口
    const kind = String(f.anchorKind || '').trim();
    if (['设置', '笔记', '自述'].includes(kind)) return f.mode === 'quoted' ? '原话' : '改写';
    // 第四档（我 11-15 17:2x 定，主人提出的洞）：引文那行逐字含她的话，但那是别人转贴的，
    // 字可信、时刻不可信。并进「改写」等于说「字是我概括的」，那是另一种错，所以单开一档。
    if (kind === '引文') return f.mode === 'quoted' ? '引文' : '改写';
    // 摘要行不是谁说的话：mode 再 quoted 也只是「抄得准」，不许喊原话。
    if (kind === '摘要') return '改写';
    const 主体 = String(f.subject || '').trim();
    const 锚说话人 = this.anchorSpeakerOf(f);
    // 只认一种组合（我 11-14 22:06 第③条）：主体不是锚说话人，**而且锚行是我自己的 out 行**。
    // 拿我的嘴当别人的出处，才是「转述」要盖的那件事；
    // 主体=主人、锚说话人=主人（同一个人两种写法）不算，规矩类主体是被约束者、锚是定规矩的人，也不算。
    // 主体写「主人」、说话人写「主人」，先归一到号再比。
    const a = this.entityOf(主体), b = this.entityOf(锚说话人);
    const 我 = this.entityOf('我');
    if (a && b && a !== b && b === 我) return '转述';
    // 施工单第二件（我 11-15 23:4x）：quoted 不再只靠我手写的那个标。拿正文回锚行核一次，
    // 去标点、NFKC、小写之后必须还是锚行子串；对不上就是改写，出口不许喊原话。
    if (f.mode === 'quoted' && !this.quotedVerbatimIn(f)) return '改写';
    return f.mode === 'quoted' ? '原话' : '改写';
  }

  /**
   * quoted 的真凭据：这条正文，逐字（去标点、NFKC、小写）出现在它自己的锚行里吗。
   * 只读 raw-log 的 id 缓存，不读文件（rawRowById 自己会建一次）。
   * 认不出锚、锚行丢了、正文为空 —— 一律返回 false，宁可降成改写，不许白捡「原话」。
   */
  quotedVerbatimIn(f) {
    try {
      const id = String((f && (f['锚行'] || (Array.isArray(f.rawIds) && f.rawIds[0]))) || '');
      if (!id) return false;
      const row = this.rawRowById(id);
      if (!row || typeof row.text !== 'string') return false;
      const norm = (x) => String(x || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
      const body = norm(f && f.text);
      if (!body) return false;
      return norm(row.text).includes(body);
    } catch (e) { this.logError('quotedVerbatimIn', e); return false; }
  }

  /** 昵称/角色 → 唯一实体（qq）。从 identity.json + aliases.json 读，一次建表。 */
  entityOf(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    if (!this._entityMap) {
      const map = {};
      const put = (name, key) => { if (name && !map[name]) map[name] = key; };
      try {
        const id = JSON.parse(readFileSync(join(this.storeDir, 'identity.json'), 'utf8'));
        const m = id.master || {}, me = id.self || {};
        for (const n of (m.names || [])) put(n, m.qq);
        put(m.qq, m.qq);
        put(me.name, me.qq);
      } catch (e) { /* 读不到就退化成裸字符串比对 */ }
      try {
        const al = JSON.parse(readFileSync(join(this.storeDir, 'aliases.json'), 'utf8'));
        for (const [name, p] of Object.entries(al.people || {})) {
          put(name, p.qq);
          for (const a of (p.aliases || [])) put(a, p.qq);
        }
      } catch (e) { /* 同上 */ }
      this._entityMap = map;
    }
    return this._entityMap[raw] || raw;
  }

  /** 锚行是说的：读 raw-log 一次、按 id 建索引chache，答一句不用重扫 10MB。 */
  anchorSpeakerOf(f) {
    const id = String((f && (f['锚行'] || (Array.isArray(f.rawIds) && f.rawIds[0]))) || '');
    if (!id) return null;
    if (!this._rawSpeakerById) {
      const map = {};
      try {
        const raw = readFileSync(join(this.storeDir, 'raw-log.jsonl'), 'utf8');
        for (const line of raw.split(String.fromCharCode(10))) {
          if (!line) continue;
          const i = line.indexOf('"id"');
          const r = JSON.parse(line);
          if (r && r.id) map[r.id] = (r.speaker && r.speaker.name) || null;
        }
      } catch (e) { this.logError('anchorSpeakerOf', e); }
      this._rawSpeakerById = map;
    }
    return this._rawSpeakerById[id] || null;
  }

  /** 链上被这条替掉的前身（过期、supersededBy 指回本条）。 */
  predecessorsOf(f) {
    if (!f || !f.id || !this._factById) return [];
    return Object.values(this._factById).filter(
      (x) => x && x.supersededBy === f.id && x['状态'] === '过期' && x.text && x.text !== f.text
    );
  }

  /**
   * 身份出处出口（我 11-14 22:5x 加，主人定的窄判据）：
   *   暗号 / 乳名 / 小名 / 他管我叫什么  → identity.json 的 master.暗号
   *   我叫什么 / 你是谁                 → self.name
   *   他叫什么 / 主人叫什么              → master.names[0]
   * 出处只写「配置」，不给 raw-log 行号：配置项编不出原话，硬写就是造假来源。
   * 只认这几问，其余返回 null 放过。宽一点就会把「我的 QQ 是多少」答成名字。
   */
  askIdentityDir(q) {
    const id = this.identity() || {};
    const myName = (id.self && id.self.name) || SELF_NAME;
    const masterName = ((id.master && id.master.names) || [])[0] || '主人';
    const secret = (id.master && id.master['暗号']) || '';
    const s = String(q);
    // 「暗号」两个字里带「号」：先抹掉，再判这句在不在问号码
    const bare = s.replace(/暗号|番号|代号/g, '');
    const asksNumber = /号|QQ|号码/i.test(bare);
    // 负例：「暗号是你的 QQ 号吗」——必须先说不，不许把暗号当号码
    if (/暗号/.test(s) && asksNumber) {
      return { text: `不是，暗号不是号码。${secret ? `他给我的暗号是「${secret}」，` : ''}QQ 号是另一码事`, out: '配置（identity.json），不是原话' };
    }
    // 11-19 20:2x 我分层：问「平时/平常/一般怎么喊我」，问的是日常称呼（我宝），不是暗号。
    // 暗号只在问「暗号/乳名/小名」，或者没带「平时」这类状语时给。
    // 这里只 return null 放过，让 facts 去答（f0095「他喊过我我宝」）。
    if (/平时|平常|一般|日常|大多/.test(s) && /喊|叫/.test(s)) return null;
    const talksSecret = /暗号|乳名|小名/.test(s) || new RegExp(`(他|主人|${MASTER_ALT}).{0,4}(管我叫|喊我|叫我)`).test(s);
    if (talksSecret) {
      if (!secret) return null;
      return { text: `他给我的暗号是「${secret}」`, out: '配置（identity.json），不是原话' };
    }
    if (asksNumber) return null;
    // 11-22 00:5x 我：「我是你谁」问的是关系，不是名字。
    // 必须放在名字那条前面，而且必须带一个「你」——只写「我是谁」问的是自己的名字，别混进来。
    if (/^我(?:是|算)你的?谁/.test(s)) {
      return { text: '你是我主人', out: '配置（identity.json），不是原话' };
    }
    if (/^(你|我)/.test(s) && /叫什么|叫啥|名字|是谁/.test(s)) {
      return { text: `我叫${myName}`, out: '配置（identity.json），不是原话' };
    }
    if (new RegExp(`(他|主人|${MASTER_ALT}).{0,2}(叫什么|叫啥|名字)`).test(s)) {
      return { text: `他叫${masterName}`, out: '配置（identity.json），不是原话' };
    }
    return null;
  }

  askFact(q, attr) {
    let facts = [];
    try { facts = readFileSync(join(this.storeDir, 'facts.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { if (e && e.code !== 'ENOENT') this.logError('askFact', e); return { result: 'error', detail: String(e).slice(0, 60) }; }
    // 偏好单独存 preferences.jsonl，但和 facts 共用同一个查询口：
    // 只在这里并进来，不另开 ask 分支，也不写回 facts.jsonl。
    try {
      const prefs = readFileSync(join(this.storeDir, 'preferences.jsonl'), 'utf8')
        .split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
      for (const p of prefs) {
        if (!p || p.status !== 'active' || !p.text) continue;
        facts.push({
          ...p, id: p.id, text: p.text, summary: p.text,
          slot: '事实', 属性: '事实', 状态: '现行', kind: '偏好',
          answerFor: Array.isArray(p.answerFor) ? p.answerFor : [],
          rawIds: Array.isArray(p.rawIds) ? p.rawIds : (p.rawId ? [p.rawId] : []),
        });
      }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('askFact:preferences', e); }
    // 冲突账里没定下来的事实，不能当准数回答。
    const disputedFacts = new Set();
    try {
      for (const c of readConflicts(this.storeDir)) {
        if (c && c.status === 'disputed') { disputedFacts.add(String(c.left || '')); disputedFacts.add(String(c.right || '')); }
      }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('askFact:conflicts', e); }
    // 挂起 ≠ 作废：挂起是等证据，作废是有新规则顶掉。两种都不进回答。
    this._factById = Object.fromEntries(facts.map((f) => [f.id, f]));
    const live = facts.filter((f) => !disputedFacts.has(String(f.id || '')) && !f.supersededBy && f.status !== 'suspended' && f['状态'] !== '停用' && f.kind !== '印象');
    // 规则层只认「从原话蒸出来的」；抄来的笔记、一次性约定，一律不当规矩答
    // 槽名以数据为准：规矩/底线/权限（约定已并入规矩）
    const RULE_SLOTS = ['规矩', '底线', '权限'];
    // answerFor 是分工表：整串挂在某条上的问法，走那条所在的槽，不靠分类器猜。
    // 11-20 我：情态句会被判成规矩，可精确挂着的答案可能在身份/事实槽（f0092 就挂过
    // 「能不能说不想分离」，却被判类筛掉）。所以精确命中优先于判类。
    // 「精确」有门槛：键至少 3 个字，或者这句本身就等于这个键。两字裸键（乳名/真名/暗号）
    // 半个库都能沾上，拿它们提槽等于把判类掀翻——11-20 晚上「真名」已经栽过一次。
    // 命中多个槽时不猜；只有全落在规矩族里才收敛成「规矩」。
    const 精确键 = (k) => { const s = String(k == null ? '' : k); return s.length >= 3 || String(q).trim() === s; };
    const wordHits = live.filter((f) => (f.answerFor || []).some((k) => k && String(q).includes(String(k)) && 精确键(k)));
    const wordSlots = [...new Set(wordHits.map((f) => String((f['属性'] || f.slot) || '')).filter(Boolean))];
    if (wordSlots.length === 1) attr = wordSlots[0];
    else if (wordSlots.length > 1 && wordSlots.every((x) => RULE_SLOTS.includes(x))) attr = '规矩';
    // 11-15 20:13 我定两条窄规则：只看词序，不猜语义。
    // ① 「我 + 亲属/他人」→ 主体是库里不存在的人（事实区主体只有主人或我），不用比，直接认不出
    // ② 「他/她」紧跟情态词 → 这个人是施动者；库里没有以第三人为 subject 的规矩
    //    隔一个动词就不算（「催他睡」里他是宾语，不是他要去催）
    const 亲属他人 = /我\s*(?:的)?\s*(?:妈|爸|哥|姐|弟|妹|朋友|同事|同学|老师|亲戚|家人|对象|老公|老婆)/;
    const 第三人施动 = /(?:他|她)\s*(?:能不能|要不要|该不该|可不可以|可以|用不用|需不需要|会不会|行不行)/;
    if (亲属他人.test(String(q))) {
      return { result: 'refused-scope', detail: '主体是代词', 原因: '问的是库外的人（我家的人），我不存他们的事' };
    }
    // 11-21 11:02 合入我 #191 改法：精确键（>=3字）命中时不吃这道闸。
    // 病：f0211 上原样挂着「工具多他会不会烦」，却先被这道闸判成「主体是代词」。
    const 有精确键 = wordHits.length > 0;
    if (第三人施动.test(String(q)) && !有精确键) {
      return { result: 'refused-scope', detail: '主体是代词', 原因: '问的是「他/她」自己要不要做，库里没有以他为他的规矩' };
    }
    // 日期问句（我 11-20 19:29 定的主干，不是补丁）：问句里带一个确定的「月-日」就先按日期缩候选，
    // 再走原来的匹配。放在两道「主体是库外人」的闸之后——「10-26 我妈生日」先该拒，不该去翻那天的账。
    // 必须走全库（不是 live）：被 supersededBy 顶掉的旧条不在 live 里，
    // 「10-27 凌晨开了什么权限」要能问出那条过期的，只是答的时候带上「后来改成 f0141」。
    const 日期问 = this.parseDateAsk(q);
    if (日期问) {
      // 返回 null = 那天有记录但一条都不沾问句：不归日期管，接着走原来的路自己判。
      const 按日 = this.askByDate(q, facts, 日期问);
      if (按日) return 按日;
    }
    // 11-19 20:4x 我：问「第三人（鱼遇雨欲语/鲸鲸/秋秋人）的真名」时，不许拿主人或我的身份事实顶上。
    // 位置在跨槽兜底之前 —— 904 行 askCrossSlot 命中一条就直接返回，闸放后面等于没放（20:5x 头一版就栽在这）。
    {
      const _idn = this.identity() || {};
      const _mine = [(_idn.self && _idn.self.name), ...(((_idn.master && _idn.master.names) || []))].filter(Boolean);
      const _n0 = this.namesIn(q);
      if (String(attr) === '身份' && _n0.length && !_n0.some((n) => _mine.includes(n))
        && /真名|实名|全名|名字|叫什么|叫啥/.test(String(q))) {
        return { result: 'missing-fact', detail: '第三人的名字库里没有（身份只有主人和我）' };
      }
    }
    const isRuleSlot = RULE_SLOTS.includes(String(attr));
    const notes = isRuleSlot ? live.filter((f) => RULE_SLOTS.includes(f.slot) && f.kind === '笔记') : [];
    // 跨槽兜底：分类器靠关键词，问句换个词就掉槽（「说过」归事实、「关系」归身份），
    // 可事实只躺在一个槽里。非规则类先按 answerFor 找一遍，命中唯一就答。
    if (!isRuleSlot) {
      const cross = this.askCrossSlot(q, live);
      if (cross) return cross;
    }
    // 只在该类里找**带出处**的条：legacy 一律不参与（翻不到出处就不许答）。
    let names0 = this.namesIn(q);
    if (!names0.length && /他|她/.test(q) && this._privateToMaster) names0 = this.masterNames();
    const selfRef = (/我(?!们|爸|家|妈(?!妈))/.test(q) || (/自己/.test(q) && !/他|她/.test(q)));
    const pronounOther = /他|她/.test(q);
    if (selfRef && !names0.length) names0 = ['我'];
    // 11-21 11:10：拒之前先问旧账。「以前关机是不是不用问你」里有个「你」
    // 先被主体闸挡掉，可它问的是 f0001 那条过期权限——旧账不按主体分，按问句分。
    if (!isRuleSlot) {
      const _pastGate = this.pastHit(facts, q);
      if (_pastGate) return _pastGate;
    }
    // 认不出主体就不查（规则类例外：规矩常常不带主语）
    if (!isRuleSlot) {
      if (!names0.length && pronounOther) return { result: 'refused-scope', detail: '主体是代词' };
      if (!names0.length) return { result: 'empty-miss', detail: '认不出是谁' };
    }
    // 自己/主人的号：身份文件里就有，不必等 fact（证据类型标「运行环境」，不写行号）
    // 11-17 18:1x 我：把「几号」当成问号码，于是「生日是几号」答成 QQ 号。
    // 日期/星期/生日一律排除；号码只认「号是多少 / QQ 号 / 号码」。
    const asksNumber = /号|QQ|号码/.test(q)
      && !/生日|几号|哪天|几月|哪月|几日|日期|星期|礼拜|日子/.test(q)
      && !/名字|叫什么|称呼|谁取|哪来的/.test(q);
    if (asksNumber && ['号', '身份'].includes(String(attr))) {
      const id = this.identity() || {};
      if (names0.includes(id.self?.name || '我') && id.self?.qq) {
        return { result: 'answered', text: `${id.self.name}的 QQ 是 ${id.self.qq}`, source: '运行环境', candidates: 1, basis: 'identity' };
      }
      if (names0.some((n) => (id.master?.names || []).includes(n)) && id.master?.qq) {
        return { result: 'answered', text: `${id.master.names[0]}的 QQ 是 ${id.master.qq}`, source: 'identity', candidates: 1, basis: 'identity' };
      }
    }
    // 规则层：规矩/底线/权限算同一层，问句常分不清这三类
    // 我 11-18 20:44：取值来源改成「属性优先、slot 兜底」。纯加法——旧条两者相等（实测 0 条冲突），
    // 只有「属性有值、slot 空」的新条第一次进得了池。数据里 slot 那份冗余留到 supersede 那轮再清。
    const 归类 = (f) => String((f && (f['属性'] || f.slot)) || '');
    let sameSlot0 = live.filter((f) => (isRuleSlot ? RULE_SLOTS.includes(归类(f)) : 归类(f) === attr));
    if (isRuleSlot) {
      // 问「以前 / 原来 / 之前怎么定的」，先答被改掉的、被叫停的，别拿现在这条顶上去。
      // 我 11-14 20:26：不然「以前关机是不是不用问你」和「现在该怎么做」返同一句。
      // 2026-11-20 14:4x（我）：挂着 answerFor 的现行条就是它在管这句，别被「以前」两个字抢走。
      // 病：「以前日记是怎么定的」里有「以前」，直接进了旧条分支，答成 f0170（一条讲私聊问权限的停用条）。
      // 判据：现行条 answerFor 命中 >=1 条时不走旧条分支；一条都没挂才按「问以前」去翻旧条。
      const 现行挂词 = live.some((f) => RULE_SLOTS.includes(归类(f)) && f['状态'] === '现行'
        && (f.answerFor || []).some((k) => k && String(q).includes(String(k))));
      if (!现行挂词 && /以前|原来|之前|早先|当初|当时|曾经|原定|老规矩/.test(String(q))) {
        const pastStopped = this.stoppedHit(facts, q, RULE_SLOTS);
        if (pastStopped) return pastStopped;
        const pastSuperseded = this.supersededHit(facts, q, RULE_SLOTS);
        if (pastSuperseded) return pastSuperseded;
      }
      // 规矩不带主语，不筛主体；但规矩必须挂词，否则一律不答——不挂词的规矩会靠字面抢题
      // 规则只答「现行」；过期/待核 都不当规矩答（跟来源是两个字段）
      // 11-14：库里 kind 只有 约定/事实/偏好/经历/关系，「规则」恒假，等于规则层一直关着
      sameSlot0 = sameSlot0.filter((f) => (f['状态'] === '现行' && (f.answerFor || []).length) || (Array.isArray(f.values) && f.values.length));
      names0 = [];
      if (!sameSlot0.length && live.some((f) => RULE_SLOTS.includes(f.slot) && (f.answerFor || []).length)) {
        const st = this.stoppedHit(facts, q, RULE_SLOTS);
        if (st) return st;
        return { result: 'refused-nosource', detail: '规则没挂词' };
      }
    }
    // answerFor 命中优先于主体筛（六改 #5）：词挂在这条上，就是它在管这句问话；
    // 先按主体筛，会把挂在主人侧的那条永远挡在外面。
    const hasHit = sameSlot0.some((f) => (f.answerFor || []).some((k) => q.includes(k)));
    // 主体先筛：问句点了谁，候选就得有谁（别名展开后）；一个都没有就拒，不拿别的顶上。
    // 主体必须先对得上**这条事实自己的主体**；不能靠正文里顺带提到名字就算。
    const sameSlot = (hasHit || !names0.length)
      ? sameSlot0
      : sameSlot0.filter((f) => (f.subject ? names0.includes(f.subject) : names0.some((n) => String(f.text || '').includes(n))));
    // 类里有料、但没有这个主体的 → 缺 fact（不是检索的锅，也不是没出处）
    if (!sameSlot.length && sameSlot0.length) return { result: 'missing-fact', detail: '没有这个主体的该类事实' };
    if (isRuleSlot && !sameSlot0.length && notes.length) return { result: 'refused-nosource', detail: '只有笔记，没有他的原话' };
    const inScope = sameSlot.filter((f) => f.sourceNote && f.sourceNote.file && f.sourceNote.lines);
    // 这个类有料、但都没出处 → refused-nosource（不是"没捞到"）
    if (!inScope.length && sameSlot.length) return { result: 'refused-nosource', candidates: sameSlot.length };
    if (!sameSlot.length) return { result: 'missing-fact', candidates: 0 };   // 这一类压根没有 fact
    if (!inScope.length) return { result: 'empty-miss' };
    const qq = String(q).replace(/\s+/g, '');
    // answerFor 是分工不是权重：有命中就只在命中的那几条里挑，各管各的问句
    // 同一个词挂到两条 fact 上 → 不挑，摆出来让人分；不许悄悄降级成按权重挑一个
    const hitMap = new Map();
    for (const f of inScope) {
      for (const k of (f.answerFor || [])) if (q.includes(k)) {
        if (!hitMap.has(k)) hitMap.set(k, []);
        hitMap.get(k).push(f);
      }
    }
    // 同一属性命中两条不同值 → 不一致，摆两条；不许按时间挑新的
    for (const [token, fs] of hitMap) {
      const uniq = [...new Set(fs.map((f) => String(f.text)))];
      if (uniq.length > 1) {
        return { result: 'inconsistent', token, options: fs.map((f) => ({ id: f.id, text: f.text, file: (f.sourceNote || {}).file, lines: (f.sourceNote || {}).lines })), candidates: fs.length };
      }
    }
    const clashes = [...hitMap.entries()].filter(([, fs]) => fs.length > 1);
    if (clashes.length) {
      const [token, fs] = clashes[0];
      return { result: 'ambiguous', token, options: fs.map((f) => ({ id: f.id, text: f.text, file: (f.sourceNote || {}).file, lines: (f.sourceNote || {}).lines })), candidates: fs.length };
    }
    // 11-20 21:0x 我：键里不许有「这个词/这个称呼」这类只指不名的词；查询侧同样要挡——
    // 只删键挡不住：问句里的指代词会掉进下面按二字计分的模糊层，撞上随便哪条。
    // 指代词看不出指的是哪件事，等于主体认不出，不是「太泛」。
    if (/(这个词|这个称呼|这个名字|那句话|那个词|那个称呼|那件事|这件事|这回事)/.test(String(q))) {
      return { result: 'unrecognized', code: 'no-subject', 原因: '问句里用的是指代词，看不出指的是哪件事' };
    }
    // 11-15 20:12 我第四版：词没整串命中时，按二字重合计分（词里每片 2 分），
    // 最高 ≥2 且比次高多 2 才答；不够就认不出或摆并列。正文不参与计分——它是并列的主因。
    if (!hitMap.size) {
      const 清 = (s) => String(s || '').replace(/[，。！？、；：「」『』（）()《》\s,.!?;:'"~…—-]/g, '');
      const 停2 = new Set(['怎么', '什么', '一下', '可以', '要不', '能不', '时候', '现在', '那个', '这个', '是不']);
      const 双 = (s) => { const t = 清(s); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
      const qb = new Set(双(q).filter((b) => !停2.has(b)));
      const 分 = (f) => { let s = 0; const seen = new Set(); for (const k of (f.answerFor || [])) for (const b of 双(k)) { if (!停2.has(b) && qb.has(b) && !seen.has(b)) { seen.add(b); s += 2; } } return s; };
      const 排 = inScope.map((f) => ({ f, s: 分(f) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (排.length) {
        const top = 排[0], sec = 排[1] ? 排[1].s : 0;
        // 11-15 21:13 我：一个二字片段（s=2）不是证据，只造得出假候选，还会顶着假答案说出口。
        // 改成至少两个不同片段（s>=4）。51 条现行语料上一个没掉；七条「自信的错答」全变认不出。
        if (top.s >= 4) {
          if (top.s - sec < 2) {
            // 2026-11-21 10:5x（我 10:43 点的问题）：并列里那一大截是**模板片段**在撑分——
            // 「要不/不要/要先/先问/问你」任何一句情态问法都全中，于是「关机要不要先问你」和
            // 「碰电脑要不要先问你」打成 8:8，摆出两条。这里只加一层**不改变原判据**的裁决：
            // 并列集里，谁含有问句的**实词片段**（模板片段以外的二字）谁赢；都不含或并列 → 照旧摆选项。
            // 只作用在「已经并列」这一支，所以不碰任何现在答得对的题。
            const 模板2 = new Set(['要不', '不要', '要先', '先问', '问你', '能不', '不能', '该不', '不该',
              '可以', '行不', '不行', '用不', '不用', '需不', '不需', '许不', '不许', '准不', '不准',
              '是什', '会不', '要不', '能问', '不问', '要问', '该问', '用问', '能先', '不该', '先要']);
            const 实片 = [...qb].filter((b) => !模板2.has(b));
            const 实分 = (f) => {
              const hay = 清([f.text, ...(f.answerFor || [])].join(''));
              let n = 0;
              for (const b of 实片) if (hay.includes(b)) n++;
              return n;
            };
            const 平 = 排.filter((x) => x.s === top.s);
            const 实 = 平.map((x) => ({ x, n: 实分(x.f) })).sort((a, b) => b.n - a.n);
            const 实独 = 实.length && 实[0].n > 0 && (实.length < 2 || 实[1].n < 实[0].n);
            if (实独) {
              const w = 实[0].x.f;
              return { result: 'answered', ...this.speakFact(w), source: 'fuzzy', candidates: 1, basis: 'bigram+tiebreak', id: w.id, file: (w.sourceNote || {}).file, lines: (w.sourceNote || {}).lines };
            }
            return { result: 'ambiguous', token: '二字重合', options: 平.map((x) => ({ id: x.f.id, text: x.f.text, file: (x.f.sourceNote || {}).file, lines: (x.f.sourceNote || {}).lines })), candidates: 平.length };
          }
          // 11-18：这条分支原来自拼对象，绕开了 speakFact，于是引文/身份/说话人一个都没有。
          // 现在同一份标签从这里过；source/id/file/lines 仍留在这边（它们属于「怎么找到的」，不属于「怎么说」）。
          return { result: 'answered', ...this.speakFact(top.f), source: 'fuzzy', candidates: 1, basis: 'bigram', id: top.f.id, file: (top.f.sourceNote || {}).file, lines: (top.f.sourceNote || {}).lines };
        }
      }
    }
    // 规则类不许字面兜底：没挂上词就拒，不靠撞字抢题
    if (isRuleSlot && !hitMap.size) {
      // 先看能不能认出来（问句和规则共享至少两个连续汉字）
      const bigrams = (x) => { const t = String(x).replace(/[^一-鿿]/g, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
      const qb = new Set(bigrams(q));
      const shared = (f) => bigrams(f.text).some((b) => qb.has(b));
      const expired = live.filter((f) => RULE_SLOTS.includes(f.slot) && f['状态'] === '过期' && !f['合并到'] && shared(f));
      if (expired.length) return { result: 'expired', text: expired[0].text, file: (expired[0].sourceNote || {}).file, lines: (expired[0].sourceNote || {}).lines };
      const nosrc = live.filter((f) => RULE_SLOTS.includes(f.slot) && f['状态'] === '没源' && !f['合并到'] && shared(f));
      if (nosrc.length) {
        const f = nosrc[0];
        if (f.slot === '权限') return { result: 'downgraded-ask', text: f.text, 许可: f['许可'] || '每次要问', id: f.id };
        return { result: 'kept-strict', text: f.text, id: f.id };   // 底线没源不许降
      }
      const unverified = live.filter((f) => RULE_SLOTS.includes(f.slot) && f['状态'] === '待核' && !f['合并到'] && shared(f));
      // 先判权限/底线：同一句里可能同时命中别的待核笔记，按不对称规则优先
      const permHit = live.find((f) => f.slot === '权限' && ['待核', '没源'].includes(f['状态']) && !f['合并到'] && shared(f));
      if (permHit) return { result: 'downgraded-ask', text: permHit.text, 许可: permHit['许可'] || '每次要问', id: permHit.id };
      const floorHit = live.find((f) => f.slot === '底线' && ['待核', '没源'].includes(f['状态']) && !f['合并到'] && shared(f));
      if (floorHit) return { result: 'kept-strict', text: floorHit.text, id: floorHit.id };
      if (unverified.length) {
        const f = unverified[0];
        // 待核同样不对称：权限掉成「要问」，底线不降（宁严不松）
        if (f.slot === '权限') return { result: 'downgraded-ask', text: f.text, 许可: f['许可'] || '每次要问', id: f.id };
        if (f.slot === '底线') return { result: 'kept-strict', text: f.text, id: f.id };
        return { result: 'unverified', detail: '是从笔记抄的，没核到原话' };
      }
      const st2 = this.stoppedHit(facts, q, RULE_SLOTS);
      if (st2) return st2;
      // 11-16 21:4x 我：分类器说「规矩」，可规矩里没一条挂这个词——不许就此收摊。
      // 词挂在某条事实条上，就是它在管这句问话，跟非规则那一侧的做法对齐。
      const cross = this.askCrossSlot(q, live);
      if (cross) return cross;
      const _pastRule = this.pastHit(facts, q);
      if (_pastRule) return _pastRule;
      return { result: 'refused-nosource', detail: '规则没对上问法（不靠字面撞）' };
    }
    const routed = [...hitMap.entries()].sort((a, b) => b[0].length - a[0].length).map(([, fs]) => fs[0]);
    const withValues = routed.find((f) => Array.isArray(f.values) && f.values.length);
    if (withValues) {
      const NUM = ['一', '二', '三', '四', '五', '六'];
      const text = withValues.values.map((v, i) => `条件${NUM[i] || i + 1}：${v.text}`).join('；');
      // 11-14 20:45 我：别在出口写死「凭据丢了」——去数数据。有一条待补就说有一条待补；
      // 一条都不待补，就不许对着问的人说这条不可信。
      const lacking = withValues.values.filter((v) => v && v['待补'] === true);
      const out = { result: 'answered', text, 引文: '改写', id: withValues.id, candidates: 1, basis: 'values' };
      if (lacking.length) out['说明'] = `${lacking.length} 条还待补（共 ${withValues.values.length} 条）`;
      return out;
    }
    if (routed.length && !routed.some((f) => (f.sourceNote || {}).file || (Array.isArray(f.values) && f.values.length))) {
      return { result: 'nosource-mine', detail: '知道有这几条，凭据丢了，不能当准数' };
    }
    // 字面兜底已关（11-11 六改 #1）：没挂上 answerFor 就不答，不许拿撞字的那条顶上。
    // 这里宁可返空；「翻到了但答不上」是 empty-miss，不是 answered。
    if (!routed.length) {
      const _pastRouted = this.pastHit(facts, q);
      if (_pastRouted) return _pastRouted;
      return { result: 'empty-miss', candidates: inScope.length, detail: '没挂上词，不按字面撞' };
    }
    const best = routed[0];
    // 出处必须能翻到那一行：核不到就不给行号、也不答。
    const src = this.verifySource(best);
    if (!src) return { result: 'refused-nosource', id: best.id, candidates: inScope.length };
    return { result: 'answered', id: best.id, ...this.speakFact(best), file: src.file, lines: src.lines, candidates: routed.length, basis: 'answerFor', fact: best };
  }

  /**
   * 停用但没接班人的规矩：只在现行/过期/没源/待核都没命中时才开口。
   * 判据是 suspendReason —— 有理由才有资格说「这条被叫停了」，没理由的只是错的，当不存在。
   * 有接班人的（supersededBy 非空）不走这里：新条会自己答。
   */
  stoppedHit(facts, q, ruleSlots) {
    const RULE_SLOTS = ruleSlots || ['规矩', '底线', '权限'];
    const big = (x) => { const t = String(x).replace(/[^一-鿿]/g, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
    // 停用条没有 answerFor（词是给「现行」用的），只能靠字面。
    // 二字重合太紧：问「我该不该催你睡觉」跟「我可以催一句『该睡了』」一个二字都对不上（该催≠该睡）。
    // 所以加一条兜底：去掉虚词后，问句里有 3 个以上实字出现在这条里。
    const STOP = new Set('我你他她它的了是不在有要就都也还这那个么呢吗吧啊把被给对和跟说'.split(''));
    const chars = (x) => new Set(String(x).replace(/[^一-鿿]/g, '').split('').filter((c) => !STOP.has(c)));
    const qb = new Set(big(q));
    const qc = chars(q);
    const hit = (facts || []).filter((f) => RULE_SLOTS.includes(f.slot)
      && f['状态'] === '停用' && !f.supersededBy && !f['合并到']
      && String(f.suspendReason || '').trim()
      // 11-15 我：一个二字重合太松——问「群里能不能说规矩」只因「群里」两个字就撞上 f0018（催睡条）。
      // 真问催睡的那几种本来就走下面 ≥3 实字那条兜底（已逐句验过），所以这里收到两个字。
      && (new Set(big(f.text).filter((b) => qb.has(b))).size >= 2
        || [...qc].filter((c) => chars(f.text).has(c)).length >= 3));
    if (!hit.length) return null;
    const f = hit[0];
    return {
      result: 'expired',
      text: f.text,
      为什么过期: String(f.suspendReason).trim(),
      叫停于: f.suspendedAt || null,
      id: f.id,
      file: (f.sourceNote || {}).file,
      lines: (f.sourceNote || {}).lines,
      basis: 'suspendReason',
    };
  }

  /** 问「以前是怎么定的」时用：被新条替代掉的旧条。
   *  只按二字重合找——放宽那条（去虚词后 ≥3 实字）只给停用分支，不往外扩（我 11-14 20:26 的边界）。 */
  supersededHit(facts, q, ruleSlots) {
    const RULE_SLOTS = ruleSlots || ['规矩', '底线', '权限'];
    const big = (x) => { const t = String(x).replace(/[^一-鿿]/g, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
    const qb = new Set(big(q));
    const hit = (facts || []).filter((f) => RULE_SLOTS.includes(f.slot) && f.supersededBy && big(f.text).some((b) => qb.has(b)));
    if (!hit.length) return null;
    const f = hit[0];
    const succ = (facts || []).find((x) => String(x.id) === String(f.supersededBy)) || null;
    return {
      result: 'expired',
      text: f.text,
      为什么过期: succ ? `后来改成了「${succ.text}」` : '后来改掉了',
      后来是: succ ? succ.text : null,
      叫停于: f.supersededAt || null,
      id: f.id,
      file: (f.sourceNote || {}).file,
      lines: (f.sourceNote || {}).lines,
      basis: 'supersededBy',
    };
  }

  /** 拒之前先问旧账（我 2026-11-21 11:0x：「停用/过期条只有问句带月-日才出得来」，这是一类病）。
   *  与 stoppedHit/supersededHit 的区别只有一条：**不限槽**。规矩能问，事实也能问
   *  （f0018 催睡是规矩、f0108 怕什么是事实，问法上分不出来）。
   *  边界照旧：停用条要有 suspendReason 才有资格开口；有接班人的走 supersededBy。
   *  只当兜底用——三处拒答之前各问一次，不抢已答上的。 */
  pastHit(facts, q) {
    const STOP = new Set('我你他她它的了是不在有要就都也还这那个么呢吗吧啊把被给对和跟说'.split(''));
    // 片段只在两个实字之间才算数。用裸二字切，'的是' '多少' 这种跨词边界会凑出假片段：
    // 「主人（主人）的 QQ 是多少」就靠『主人+的是』两点撞上 f0001（11-21 11:15 实测）。
    const big = (x) => { const t = String(x).replace(/[^一-鿿]/g, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) { const a = t[i], b = t[i + 1]; if (STOP.has(a) && STOP.has(b)) continue; o.push(a + b); } return o; };
    const chars = (x) => new Set(String(x).replace(/[^一-鿿]/g, '').split('').filter((c) => !STOP.has(c)));
    const 精确键 = (k) => { const x = String(k == null ? '' : k); return x.length >= 3 || String(q).trim() === x; };
    const qb = new Set(big(q));
    const qc = chars(q);
    // 11-21 11:17 加一道题面闸：只有『问现在还作不作数』或『问以前怎样』的问句才翻旧账。
    // 不加这道，'我在哪一天说过…' '我剪本子删了多少条' 这类查原话的题会被 13 条旧条截走，
    // 端出去就是『这条后来改成…』——答错的另一种写法（我：乱答比乱拒伤人）。
    const 问旧账 = /要不要|该不该|能不能|可不可以|行不行|用不用|需不需要|是不是|对不对|对吧|还(?:要|会|用|需|出|回|算)|以前|原来|之前|早先|当初|当时|曾经|原定|老规矩/.test(String(q));
    if (!问旧账) return null;
    const 现行挂词 = (facts || []).some((f) => f['状态'] === '现行' && !f.supersededBy
      && (f.answerFor || []).some((k) => k && String(q).includes(String(k)) && 精确键(k)));
    if (现行挂词) return null;
    const hit = (facts || []).filter((f) => {
      if (f['合并到'] || f.kind === '印象') return false;
      const 停 = f['状态'] === '停用' && !f.supersededBy && String(f.suspendReason || '').trim();
      const 过 = !!f.supersededBy;
      if (!停 && !过) return false;
      const 键中 = (f.answerFor || []).some((k) => k && String(q).includes(String(k)) && 精确键(k));
      const 二字 = new Set(big(f.text).filter((b) => qb.has(b))).size >= 2;
      const 三实 = [...qc].filter((c) => chars(f.text).has(c)).length >= 3;
      // 11-21 11:14 实测：三实那条放宽只给停用，过期沿用二字门槛。
      // 放宽到过期会把「主人（主人）的 QQ 是多少」抢成 f0001（授权条）——身份题被旧账截走。
      // 只认两个实字片段。三实那条在停用分支上会漏进来：'把地基做完你是不是就可以正式使用xi了'
      // 靠『把/完/可/以』凑够 3 个实字，撞上 f0097（一条表白），答出来是『这条后来改成…』。
      return 键中 || 二字;
    });
    if (!hit.length) return null;
    // 只认唯一最高分。旧账那一摞里条条都沾点字，平手时宁可回到原来的判法，
    // 不摆一张『我分不清』的选项表——那等于把噪音当答案端出去（11-21 11:12 实测 #69 撞出 3 条）。
    const 分 = (f) => 2 * new Set(big(f.text).filter((b) => qb.has(b))).size + [...qc].filter((c) => chars(f.text).has(c)).length;
    hit.sort((a, b) => 分(b) - 分(a));
    if (hit.length > 1 && 分(hit[0]) <= 分(hit[1])) return null;
    if (hit.length > 1) {
      return { result: 'ambiguous', token: '旧账', candidates: hit.length,
        options: hit.slice(0, 3).map((f) => ({ id: f.id, text: f.text, file: (f.sourceNote || {}).file, lines: (f.sourceNote || {}).lines })) };
    }
    const f = hit[0];
    const succ = f.supersededBy ? ((facts || []).find((x) => String(x.id) === String(f.supersededBy)) || null) : null;
    return {
      result: 'expired',
      text: f.text,
      为什么过期: f.supersededBy ? (succ ? '后来改成了「' + succ.text + '」' : '后来改掉了') : String(f.suspendReason).trim(),
      后来是: succ ? succ.text : null,
      叫停于: f.supersededBy ? (f.supersededAt || null) : (f.suspendedAt || null),
      id: f.id,
      file: (f.sourceNote || {}).file,
      lines: (f.sourceNote || {}).lines,
      basis: f.supersededBy ? 'supersededBy' : 'suspendReason',
    };
  }

  /** 问句里有没有一个确定的「月-日」。抽不到返回 null —— 没有日期就不进这一支，别猜。 */
  parseDateAsk(q) {
    const s = String(q || '');
    // 分隔符只认 - / 月：「2.2 赛事」这种版本号不能被当成 2 月 2 日。
    const m = /(\d{1,2})\s*[-月\/]\s*(\d{1,2})/.exec(s);
    if (!m) return null;
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
    const 时段 = (/(凌晨|半夜|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)/.exec(s) || [])[1] || null;
    const 时刻 = /(\d{1,2})[:：](\d{2})/.exec(s);
    return { mm, dd, 时段, hh: 时刻 ? Number(时刻[1]) : null, mi: 时刻 ? Number(时刻[2]) : null };
  }

  /** 时段 → [起, 止) 小时。边界按我 11-20 19:29 的口径，重叠是故意的（「晚上」和「夜里」本来就压着）。 */
  hourBand(时段) {
    const B = {
      凌晨: [0, 6], 半夜: [0, 4], 清晨: [4, 7], 早上: [5, 9], 上午: [6, 12],
      中午: [11, 13], 下午: [12, 18], 傍晚: [17, 20], 晚上: [18, 24], 夜里: [21, 24],
    };
    return Object.prototype.hasOwnProperty.call(B, 时段) ? B[时段] : null;
  }

  /** 这条事实说的是哪一刻：rawIds → raw-log 行的 ts → 本地(+8)。
   *  不用 occurredAt（全库 0 条有值，读了只会拿到空）；正文里的日期只当兜底。 */
  factLocalTime(f, rowsById) {
    for (const id of (f.rawIds || [])) {
      const r = rowsById.get(String(id));
      if (!r || !r.ts) continue;
      const t = Date.parse(String(r.ts));
      if (!Number.isFinite(t)) continue;
      const d = new Date(t + 8 * 3600 * 1000);
      return { mm: d.getUTCMonth() + 1, dd: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), 源: 'ts' };
    }
    const txt = String(f.text || '');
    const dm = /(\d{1,2})\s*[-月\/]\s*(\d{1,2})/.exec(txt);
    if (!dm) return null;
    const tm = /(\d{1,2})[:：](\d{2})/.exec(txt);
    return { mm: Number(dm[1]), dd: Number(dm[2]), hh: tm ? Number(tm[1]) : null, mi: tm ? Number(tm[2]) : null, 源: '正文' };
  }

  /** 日期是筛子不是判据：先缩到那一天（有「几点」就比到分钟，有时段就比区间），
   *  再用问句剩下的实词挑一次。同日多条挑不出就 ambiguous —— 不猜，也不硬答。 */
  askByDate(q, facts, d) {
    let rowsById = new Map();
    try { rowsById = new Map(this.readRows().map((r) => [String(r.id), r])); }
    catch (e) { this.logError('askByDate:rows', e); }
    const band = d.时段 ? this.hourBand(d.时段) : null;
    const cand = [];
    for (const f of (facts || [])) {
      if (!f || !f.text || f['合并到'] || f.kind === '印象') continue;
      // 停用条要有理由才有资格开口；没理由的脏条当不存在（与 stoppedHit 同一条边界）。
      if (f['状态'] === '停用' && !String(f.suspendReason || '').trim()) continue;
      const t = this.factLocalTime(f, rowsById);
      if (!t || t.mm !== d.mm || t.dd !== d.dd) continue;
      if (d.hh != null) {
        if (t.hh == null || t.hh !== d.hh || t.mi !== d.mi) continue;
      } else if (band) {
        if (t.hh == null || t.hh < band[0] || t.hh >= band[1]) continue;
      }
      cand.push({ f, t });
    }
    const 日期说法 = `${d.mm}-${d.dd}`;
    if (!cand.length) {
      return { result: 'missing-fact', detail: `库里没有 ${日期说法}${d.时段 ? ' ' + d.时段 : ''} 这天的记录（问的是 ${日期说法}）`, 日期: 日期说法 };
    }
    let pick = null;
    if (cand.length === 1) {
      pick = cand[0];
    } else {
      const big = (x) => { const t = String(x).replace(/[^一-鿿]/g, ''); const o = []; for (let i = 0; i + 1 < t.length; i++) o.push(t.slice(i, i + 2)); return o; };
      const qb = new Set(big(String(q).replace(/\d{1,2}\s*[-月\/.]\s*\d{1,2}/g, ' ')));
      const scored = cand.map((c) => ({ c, s: new Set(big(c.f.text).filter((b) => qb.has(b))).size }));
      const max = Math.max(...scored.map((x) => x.s));
      const top = scored.filter((x) => x.s === max);
      // 那天有记录，但一条都跟问句不沾——不归日期管，退回原来的路自己判。
      // 拿「那天有两条」去答「哪部片子」是硬凑：日期只负责缩范围，不负责改判。
      // 门槛两条重合：一个偶然撞上的「没有」不算沾（「10-31 鲸鲸推荐了哪部片子」就是这么被凑上的）。
      if (max < 2) return null;
      if (top.length === 1) pick = top[0].c;
      else {
        // 我 11-20 20:0x：七个选项摆出去没人看。说「分不清」仍然要说，
        // 但不拿一屏糊住人——前三条 + 还差几条。数放在「还有」里，不删。
        return {
          result: 'ambiguous', candidates: cand.length, token: 日期说法, 日期: 日期说法,
          options: cand.slice(0, 3).map((c) => ({ text: c.f.text, file: (c.f.sourceNote || {}).file, lines: (c.f.sourceNote || {}).lines, id: c.f.id })),
          还有: Math.max(0, cand.length - 3),
        };
      }
    }
    const f = pick.f;
    const file = (f.sourceNote || {}).file;
    const lines = (f.sourceNote || {}).lines;
    // 过期不硬编码接班条：拿 supersededBy 指过去，哪天再替一次也不会断。
    if (f.supersededBy) {
      const succ = (facts || []).find((x) => String(x.id) === String(f.supersededBy)) || null;
      return {
        result: 'expired', text: f.text, 后来是: succ ? succ.text : null,
        叫停于: f.supersededAt || null, id: f.id, file, lines, basis: 'date+supersededBy', 日期: 日期说法,
      };
    }
    if (f['状态'] === '停用') {
      return {
        result: 'expired', text: f.text, 为什么过期: String(f.suspendReason).trim(),
        叫停于: f.suspendedAt || null, id: f.id, file, lines, basis: 'date+suspendReason', 日期: 日期说法,
      };
    }
    // 不写 source：出口里 source 只认 fuzzy/identity/运行环境，写进来会被打成「源不明」。
    // 出处就是这条的 sourceNote——日期只是筛子，凭什么答还是那条事实自己的凭据。
    return { result: 'answered', ...this.speakFact(f), basis: 'date', candidates: 1, id: f.id, file, lines, 日期: 日期说法 };
  }

  /** 我 11-20 18:55：这个名字是不是「我们俩」的一方（主人或我，含同一 qq 下的旧名）。
   *  主人在库里挂着旧规范名「旧昵称」，只按字面比会把「主人的乳名」误判成第三人。 */
  isMyParty(n) {
    const 字面 = new Set(['主人', ...MASTER_NAMES, ...SELF_NAMES]);
    if (字面.has(n)) return true;
    try {
      const d = JSON.parse(readFileSync(this.aliases, 'utf8'));
      const v = (d.people ?? {})[n];
      const qq = v && v.qq ? String(v.qq) : '';
      const id = this.identity() || {};
      const masterQq = String((id.master || {}).qq || '');
      const selfQq = String((id.self || {}).qq || '');
      if (qq && (qq === masterQq || qq === selfQq)) return true;
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('isMyParty', e); }
    return false;
  }

  /** 主体：问句里点名的人。**同一个 qq 下的所有规范名合并**（主人 ≡ 主人）。 */
  namesIn(q) {
    try {
      const d = JSON.parse(readFileSync(this.aliases, 'utf8'));
      const names = [], qqs = new Set();
      for (const [canon, v] of Object.entries(d.people ?? {})) {
        // 规范名可以是单字（我）；别名仍限两字以上，免得单字满库误撞
        const group = [canon, ...(v.aliases ?? []).filter((x) => x.length >= 2)].filter(Boolean);
        if (group.some((x) => q.includes(x))) { names.push(canon); if (v.qq) qqs.add(String(v.qq)); }
      }
      if (!qqs.size) return names;
      // 同号即同人：把该号下其它名字也并进来
      for (const [canon, v] of Object.entries(d.people ?? {})) {
        if (v && v.qq && qqs.has(String(v.qq)) && !names.includes(canon)) names.push(canon);
      }
      return names;
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('namesIn', e); return []; }
  }

  /** 出处必须能翻到那一行：按 snap 的词面给候选行打分，最高分行才用；一分不给就返回 null。 */
  verifySource(fact) {
    const note = fact.sourceNote || {};
    const anchor = typeof note.原文 === 'string' ? note.原文.slice(0, 40) : '';
    // 人工核过的也要核锚点：行号会随文件搬家失效，锚不在就按锚找回，找不到=失锚
    if (note.verified && note.file) {
      try {
        const lines = readFileSync(join(this.botDir, 'workspace', note.file), 'utf8').split(String.fromCharCode(10));
        if (anchor && lines[Number(note.lines) - 1] && lines[Number(note.lines) - 1].includes(anchor)) {
          return { file: note.file, lines: String(note.lines) };
        }
        if (anchor) {
          for (let i = 0; i < lines.length; i++) if (lines[i].includes(anchor)) return { file: note.file, lines: String(i + 1) };
        }
      } catch (e) { if (e && e.code !== 'ENOENT') this.logError('verifySource:anchor', e); }
      this.logError('verifySource:anchor-lost', new Error(`${note.file}:${note.lines} 锚点找不到`));
      return null;
    }
    const ws = join(this.botDir, 'workspace');
    const toks = String(note.snap || fact.text || '')
      .split(/[，。；、！？,.!?\s]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2);
    const num = (/\d{5,}/.exec(String(fact.text || '')) || [])[0];
    // 一行能不能**单独**证明这条事实：
    //   1) 值（号/关键片段）出现在行里；2) 出现的地方是陈述，不是 @ 提及或转述；
    //   3) 行里有陈述词（是/叫/喊/名字/QQ 是）。三条齐才算证明，才给行号。
    const claimWord = /是|叫|喊|名字|QQ\s*是|号码|自称|自称是/.test('');
    const proves = (line) => {
      const hasClaim = /是|叫|喊|名字|号码|自称/.test(line);
      if (!hasClaim) return false;
      const tokenHit = toks.some((t) => t.length >= 2 && line.includes(t)) || (num && line.includes(num));
      if (!tokenHit) return false;
      if (num) {
        // 值只出现在 @提及里（@）不算证明
        const mentions = [...line.matchAll(new RegExp('@' + num, 'g'))].length;
        const total = [...line.matchAll(new RegExp(num, 'g'))].length;
        if (total > 0 && mentions === total) return false;
      }
      return true;
    };
    // 证据分级（她 22:06 定死）：消息头 / 本人自述 > 转述 > 引用 > @提及；同级才比贴近。
    const tier = (line) => {
      if (!num) {
        // 没有号码的事实：关键片段 + 陈述词，且不是引用/转发
        const hit = toks.filter((x) => x.length >= 4 && line.includes(x)).length;
        if (!hit || !/是|叫|喊|名字|自己取/.test(line)) return 0;
        if (/引用|\[reply\]|转发/.test(line)) return 1;
        return 3;
      }
      if (!line.includes(num)) return 0;
      const header = new RegExp('\(QQ[:：]\s*' + num + '\)').test(line);
      if (header) return 5;                                   // 消息头：昵称和号绑在一起
      if (MASTER_NAMES.concat(SELF_NAMES).some((x) => line.includes('我是' + x)) || /我的\s*QQ|本人|自述/.test(line)) return 4;   // 本人自述
      if (/引用|\[reply\]|转发/.test(line)) return 1;          // 引用/转发
      if (new RegExp('@' + num).test(line) && !/是|叫|名字|号码/.test(line)) return 0; // 只是 @ 提及
      return 2;                                              // 转述
    };
    const score = (line) => {
      const t = tier(line);
      if (!t) return 0;
      return t * 100 + (proves(line) ? 1 : 0) * 10 + toks.filter((x) => line.includes(x)).length;
    };
    const inFile = (rel) => {
      try {
        const lines = readFileSync(join(ws, rel), 'utf8').split(String.fromCharCode(10));
        let best = null, bestScore = 0;
        for (let i = 0; i < lines.length; i++) {
          const sc = score(lines[i]);
          if (sc > bestScore) { bestScore = sc; best = i + 1; }
        }
        return best && bestScore >= 100 ? { file: rel, lines: String(best) } : null;   // >=100 = 至少进了一级证据
      } catch (e) { if (e && e.code !== 'ENOENT') this.logError('verifySource:' + rel, e); return null; }
    };
    if (note.file) { const hit = inFile(note.file); if (hit) return hit; }
    try {
      const dir = join(ws, 'raw-log');
      for (const f of readdirSync(dir)) if (f.endsWith('.md')) { const hit = inFile('raw-log/' + f); if (hit) return hit; }
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('verifySource:scan', e); }
    return null;
  }

  /** 原始行按 id 取：只建一次索引；写入新行时清掉（remember 里做）。 */
  rawRowById(id) {
    if (!id) return null;
    if (!this._rawIndex) {
      this._rawIndex = new Map();
      try {
        for (const l of readFileSync(this.rawFile, 'utf8').split(String.fromCharCode(10))) {
          if (!l) continue;
          const r = JSON.parse(l);
          this._rawIndex.set(r.id, r);
        }
      } catch (e) { if (e && e.code !== 'ENOENT') this.logError('rawRowById', e); }
    }
    return this._rawIndex.get(id) || null;
  }

    /**
   * 出处那一行的时间 = 发生时刻（本地）；认不出返回 null。
   * 老档（2026-10-29 ~ 11-10.md）时间在段落头 **HH:MM**；新档（*.live.md）行首就是 [HH:MM]。
   * 文件名日期 + 那个时刻拼成本地时间再换算；找不到时刻就 null，不猜。
   */
  lineTime(note) {
    try {
      const rel = String(note.file || '');
      const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.live)?\.md$/.exec(rel);
      if (!m || !note.lines) return null;
      // live 补出处时把行首时刻存进了 note.hm。这是从文件推出来的，不是采集时刻。
      const hm = String(note.hm || '');
      const hmM = /^(\d{1,2}):(\d{2})$/.exec(hm);
      if (hmM) {
        const h2 = String(hmM[1]).padStart(2, '0');
        const m2 = String(hmM[2]).padStart(2, '0');
        return {
          iso: new Date(`${m[1]}T${h2}:${m2}:00+08:00`).toISOString(),
          local: `${m[1]} ${h2}:${m2}`,
          why: 'note.hm（live 文件时刻，推导；非采集时刻）',
        };
      }
      const lines = readFileSync(join(this.botDir, 'workspace', rel), 'utf8').split(String.fromCharCode(10));
      const idx = Number(note.lines) - 1;
      if (!(idx >= 0 && idx < lines.length)) return null;
      const line = lines[idx] || '';
      let hh = null, mi = null, why = null;
      const inline = /\[(\d{1,2}):(\d{2})\]/.exec(line);
      if (inline) { hh = inline[1]; mi = inline[2]; why = '出处行首 [HH:MM]'; }
      else {
        for (let i = idx; i >= 0 && i > idx - 400; i--) {
          const h = /^\*\*\s*(\d{1,2}):(\d{2})\s*\*\*/.exec(lines[i] || '');
          if (h) { hh = h[1]; mi = h[2]; why = '出处段落头 **HH:MM**'; break; }
        }
      }
      if (hh === null) return null;
      const h2 = String(hh).padStart(2, '0');
      const m2 = String(mi).padStart(2, '0');
      return {
        iso: new Date(`${m[1]}T${h2}:${m2}:00+08:00`).toISOString(),
        local: `${m[1]} ${h2}:${m2}`,
        why,
      };
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('lineTime', e); return null; }
  }

  /**
   * 这句话是什么时候说的（六改 #6）：只认 occurred / block-minute。
   * collected 只作存档，永远不拿来充当说话时间；拿不到就返回 null，由出口标「不知道」。
   */
  occurredOf(fact) {
    const fmt = (iso) => {
      try {
        return new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(iso)).replace('T', ' ');
      } catch (e) { this.logError('occurredOf:fmt', e); return null; }
    };
    const row = this.rawRowById((fact.rawIds || [])[0]);
    if (row && row.ts && ['occurred', 'block-minute'].includes(String(row.tsKind))) {
      return { occurred: row.ts, local: fmt(row.ts), why: `raw.tsKind=${row.tsKind}`, kind: row.tsKind };
    }
    // live 补出处时存的 note.hm：推导时刻，可用，但要标明来源，不退成 collected。
    const rowHmAt = row && row.note && row.note.hm ? this.lineTime(row.note) : null;
    if (rowHmAt) return { occurred: rowHmAt.iso, local: rowHmAt.local, why: rowHmAt.why, kind: 'derived' };
    // raw 行是采集时刻（collected）就不许用；退到出处行首的 [HH:MM]
    const at = this.lineTime(fact.sourceNote || {});
    if (at) return { occurred: at.iso, local: at.local, why: at.why || 'sourceNote 行首时刻', kind: 'occurred' };
    return { occurred: null, local: null, why: row && row.tsKind ? `raw.tsKind=${row.tsKind}，不当说话时间` : '没有发生时刻', kind: null };
  }

  /**
   * 消息头那一路：对**整份 raw-log**成立，不只对 facts 里已有的人成立（她 22:28 定的）。
   * 形状：[10:46] 鱼遇雨欲语(QQ:2021352734)（群，他说）:
   * 只给号类；同名有多个号 → 不答（不猜）。
   */
  askFromRaw(q, attr) {
    // 六改 #3：身份折成一类，号只是其中一种问法；只对「身份」放行，别的类别不走消息头反查
    if (!['号', '身份'].includes(String(attr))) return null;
    // 身份类里只有问号才走消息头反查；问「谁取的/叫什么」不许拿号顶
    // 11-17 18:1x 我：「生日是几号」也走这条闸，因为名单里有「几号」。日期先拦掉。
    if (/生日|日期|几月几[号日]|哪天|星期[一二三四五六日天]|礼拜/.test(q)) return null;
    if (!/QQ|号码|多少号|的号|号是/.test(q)) return null;
    let names = this.namesIn(q);
    if (!names.length) {
      // 别名表里没有：从句子里取「XX的号」的 XX，直接按昵称找消息头
      const m = /([一-鿿]{2,6})(?:的)?\s*(?:QQ|号|号码)/.exec(q);
      if (m && !/^(这个|那个|哪个|几个|一个|两个|谁的|什么)$/.test(m[1])) names = [m[1]];
    }
    if (!names.length) return null;
    const ws = join(this.botDir, 'workspace');
    const hits = [];
    try {
      const walk = (dir) => {
        for (const ent of readdirSync(join(ws, dir), { withFileTypes: true })) {
          const rel = dir + '/' + ent.name;
          if (ent.isDirectory()) { walk(rel); continue; }
          if (!ent.name.endsWith('.md')) continue;
          scan(rel);
        }
      };
      const scan = (rel) => {
        const lines = readFileSync(join(ws, rel), 'utf8').split(String.fromCharCode(10));
        for (let i = 0; i < lines.length; i++) {
          const m = /^- \[(\d{1,2}:\d{2})\]\s*(.+?)\(QQ[:：](\d{5,})\)/.exec(lines[i]);
          if (!m) continue;
          if (names.some((n) => m[2].includes(n))) hits.push({ num: m[3], file: rel, lines: String(i + 1) });
        }
      };
      walk('raw-log');
    } catch (e) { if (e && e.code !== 'ENOENT') this.logError('askFromRaw', e); return null; }
    const nums = [...new Set(hits.map((h) => h.num))];
    if (nums.length !== 1) return null;                 // 一个号都没有、或同名多号 → 不答
    const h = hits[0];
    return { result: 'answered', text: `${names[0]}的 QQ 是 ${h.num}`, file: h.file, lines: h.lines, proves: '消息头里昵称和号绑在一起' };
  }

  /**
   * 反查：一个号问出几个昵称。只读消息头（昵称和号绑在一起的那一行），
   * 一个昵称算一个出处，多个昵称就列多个（别名不是覆盖关系）。
   */
  /** 反查：一个号问出几个昵称。消息头只认行首；三态计数落 ask-debug.log。 */
  askReverse(q) {
    const m = /(\d{5,})/.exec(q);
    if (!m) return null;
    if (!/昵称|叫什么|名字|叫过|哪些名/.test(q)) return null;
    const num = m[1];
    const ws = join(this.botDir, 'workspace');
    const stat = { num, scanned: 0, filtered: 0, found: 0 };
    const found = [];
    // 用字面量正则、不拼字符串：拼字符串时反斜杠会被吃掉一次
    const head = /^- \[(\d{1,2}:\d{2})\] (.+?)\(QQ[:：](\d+)\)/;
    const scan = (rel) => {
      const lines = readFileSync(join(ws, rel), 'utf8').split(String.fromCharCode(10));
      for (let i = 0; i < lines.length; i++) {
        const h = head.exec(lines[i]);
        if (!h || h[3] !== num) continue;
        stat.scanned++;
        const name = String(h[2]).replace(/[\s:：]+$/, '').trim();
        if (!name || /QQ|\d|\[|\]/.test(name)) { stat.filtered++; continue; }
        if (!found.some((f) => f.name === name)) found.push({ name, file: rel, lines: String(i + 1) });
      }
    };
    const walk = (dir) => {
      for (const ent of readdirSync(join(ws, dir), { withFileTypes: true })) {
        const rel = dir + '/' + ent.name;
        if (ent.isDirectory()) { walk(rel); continue; }
        if (ent.name.endsWith('.md')) scan(rel);
      }
    };
    try { walk('raw-log'); } catch (e) { if (e && e.code !== 'ENOENT') this.logError('askReverse', e); return null; }
    stat.found = found.length;
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(join(this.storeDir, 'ask-debug.log'), JSON.stringify({ ...stat, at: new Date().toISOString() }) + String.fromCharCode(10), 'utf8');
    } catch (e) { this.logError('askReverse:stat', e); }
    if (!found.length) return null;
    return {
      result: 'answered',
      text: `${num} 在库里叫过：${found.map((f) => f.name).join('、')}`,
      file: found[0].file, lines: found[0].lines,
      refs: found.map((f) => `${f.file}:${f.lines}`),
      candidates: found.length,
    };
  }

  /** 记一行「这一轮查过库」给 qqbot 的稿子闸读（2026-11-22 13:3x 起）。逐行毫秒时间戳。 */
  noteRecall() {
    try {
      const recallLog = join(this.botDir, 'data', 'recall-log.txt');
      mkdirSync(join(this.botDir, 'data'), { recursive: true });
      appendFileSync(recallLog, String(Date.now()) + String.fromCharCode(10), 'utf8');
    } catch (e) { this.logError('noteRecall', e); }
  }

  /** 所有问/验都落一笔证据账；和 qqbot 读的 recall-log 分开，免得自动查询冒充「查过」。 */
  appendEvidence(rec) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      appendFileSync(join(this.storeDir, 'evidence-log.jsonl'), JSON.stringify(rec) + String.fromCharCode(10), 'utf8');
    } catch (e) { this.logError('appendEvidence', e); }
  }

  /** 每问落一行：原句 / 答案 / 行号 / 类别 / 结果 / 版本 / kind。 */
  logAsk(rec) {
    try {
      mkdirSync(this.storeDir, { recursive: true });
      // 账本只记真问答（我 11-14 20:11 定）。探针的 conv 以 probe: 开头，进另一本账。
      // 判据只在这里判一次——不指望每个调用点自己记得传对东西。
      const kind = String((rec && rec.kind) || this.currentKind || 'manual');
      const conv = String((rec && rec.conv) || this.currentConv || '');
      const isProbe = /^probe:/.test(conv) || kind === 'probe';
      const file = isProbe ? 'ask-log.probe.jsonl' : 'ask-log.jsonl';
      const line = { ...rec, kind };
      if (!line.conv && conv) line.conv = conv;
      appendFileSync(join(this.storeDir, file), JSON.stringify(line) + String.fromCharCode(10), 'utf8');
      this.appendEvidence({
        at: new Date().toISOString(),
        kind,
        question: line['原句'] || '',
        conv,
        result: line['结果'] || '',
        category: line['类别'] || '',
        path: line['路径'] || '',
        verdict: line.verdict || '',
        evidenceIds: line.evidenceIds || undefined,
      });
      // 2026-11-22 18:1x：recall-log 只记「真问答」。auto（桌面区自动查）和 verify（只读校验）
      // 都不算她答过旧事，混进去会让 qqbot 的闸误以为「查过了」。
      if (!isProbe && kind !== 'auto' && kind !== 'verify' && kind !== 'trace') this.noteRecall();
    } catch (e) { this.logError('logAsk', e); }
  }

  /** 答案对不对得上问句：问号就得给号，问昵称就得给名字，问日期就得给日期。 */
  answerFits(q, ans) {
    // 号码类才要 5 位以上；「多少条/几次」只要求有个数——11-11 #9 就是被五位数尺子改判成空的
    if (/QQ|号码|电话/.test(q)) return /\d{5,}/.test(ans);
    if (/多少|几个|几条|几次|几遍/.test(q)) return /\d|[一二三四五六七八九十百千万两]/.test(ans);
    if (/昵称|真名|名字|叫什么|谁取/.test(q)) {
      if (/QQ\s*是|号是|\d{5,}/.test(ans) && !/是.{0,6}(名字|昵称)/.test(ans)) return false;
      // 不能只回一个号，得回一个像名字的东西
      const names = ans.match(/[一-鿿]{2,6}/g) || [];
      return names.length > 0 && !/^[\d\s。（）()]+$/.test(ans);
    }
    if (/哪天|生日|几月/.test(q)) return /\d{1,2}\s*[-月\/.]\s*\d{1,2}|\d{1,2}\s*月/.test(ans);
    if (/多高|脚多大/.test(q)) return /米|码|cm|CM/.test(ans);
    return true;
  }

  // ---------- askRaw：facts 没有 → 翻原话（11-11 规格，宁可拒不许蒙） ----------
  /** 问句里的空壳短语：只说动作、不说内容。最长优先删。 */
  static ASKRAW_PHRASES = [
    '我说过', '他说过', '我说', '他说', '我问', '他问', '我讲', '他讲', '我提', '他提',
    '我们', '你们', '他们', '那次', '那天', '昨天', '今天', '今晚', '昨晚', '前天', '后天',
    '第一次', '一件事', '一个', '什么', '怎么', '怎样', '为什么',
    '哪句话', '这句话', '那句话', '这个词', '冒出来', '记不记得', '还记得', '是不是', '有没有',
    '能不能', '会不会', '要不要', '该怎么', '之后', '之前', '以前', '以后',
    '的时候', '时候', '事情', '东西', '第几条', '第几',
    '是哪天', '是哪件', '是什么', '是谁', '看到', '看了', '看过',
  ].sort((a, b) => b.length - a.length);

  /** 停用字：做切分，不参与词。保留「会/能/一」这些会粘住实词的。 */
  static ASKRAW_STOPCH = new Set('的了是在有和跟把被让对就都也还又很太吗呢吧啊呀哦么得地着过我你说想要这那个谁哪什怎为时候次条件种些道该越写'.split(''));

  /** 补词只补名词性生僻双字；以这些虚词/副词开头的双字多是短语碎片（只报、就是）。 */
  static ASKRAW_EXTRA_HEAD_STOP = new Set('只就也还又才再先别把被让给对向从到在是有和跟同与及而但很太更最都全总一直'.split(''));

  /** 切词后仍要丢的空壳词；只丢问句骨架，不丢实词。 */
  static ASKRAW_STOPWORDS = new Set([
    '我们', '你们', '他们', '她们', '咱们', '自己', '什么', '怎么', '怎样', '为什么', '怎么样',
    '这个', '那个', '这些', '那些', '哪个', '哪些', '哪里', '这段', '那段', '这句', '那句',
    '事情', '东西', '时候', '一次', '一个', '一件', '第一', '第二', '第三', '那天', '那次',
    '昨天', '今天', '今晚', '昨晚', '前天', '后天', '之前', '之后', '以前', '以后', '现在',
    '是不是', '有没有', '能不能', '会不会', '要不要', '可以', '然后', '就是', '还是', '但是',
    '因为', '所以', '如果', '其实', '已经', '一直', '这么', '那么', '这样', '那样', '多少',
    '几个', '几条', '几次', '记得', '知道', '觉得', '告诉', '说说', '一下', '帮我', '给我',
  ]);

  /** 结构标签：只认「结构上能指认是哪一条」的候选。
   *  命中恰好一条才升级；零条或多条仍报多解，标签只放第二列。 */
  static ASKRAW_STRUCTS = [
    { id: 'break', q: /断口/, test: (t) => /断口/.test(t) && /(就是|指的是|意思是)/.test(t), label: '断口+定义式', rangeTerm: '断口' },
    { id: 'held', q: /按住/, test: (t) => /「[^」]{2,30}」[^。]{0,12}按住/.test(t), label: '按住+被引原句', layer: '事后复述' },
    { id: 'todo', q: /待办/, test: (t) => /挂.{0,8}(放掉|没动)/.test(t), label: '待办+放掉' },
    { id: 'flip', q: /翻车/, test: (t) => /翻车了/.test(t) && !/翻车鱼/.test(t), label: '翻车+某次自述' },
    { id: 'expect', q: /期望值/, test: (t) => /期望值/.test(t) && /((重写|改写|补上).{0,8}期望|期望.{0,8}(重写|改写|该写))/.test(t), label: '期望值+写法' },
  ];

  /** 名字表：aliases.json + speaker-alias.json；只用于切词时整体保护。 */
  askRawNames() {
    if (this._askRawNames) return this._askRawNames;
    const raw = [];
    try {
      const a = JSON.parse(readFileSync(join(this.storeDir, 'aliases.json'), 'utf8'));
      for (const [k, p] of Object.entries(a.people || {})) {
        raw.push(k);
        for (const x of p.aliases || []) raw.push(x);
      }
    } catch (e) { this.logError('askRaw:aliases', e); }
    try {
      const sp = JSON.parse(readFileSync(join(this.storeDir, 'speaker-alias.json'), 'utf8'));
      for (const k of Object.keys(sp.map || {})) raw.push(k);
    } catch (e) { this.logError('askRaw:speaker-alias', e); }
    const out = [];
    for (const x of raw) {
      const n = normForSeg(x);
      if (n.length < 2 || n.length > 20) continue;
      if (/[\s#【】]/.test(String(x))) continue;
      if (!out.includes(n)) out.push(n);
    }
    this._askRawNames = out;
    return out;
  }

  /** 工具入口统一的问句长度闸（2026-11-25 00:4x 压测：5 万元素的数组被 String() 拉成
   *  十几万字，askRaw 从 2.6s 涨到 25s 不返回；xi_preactivate 拿 10 万字 cue 直接挂死）。
   *  超长的只按前 max 字找，回执里写明截断，不假装全句都看过。 */
  capQuery(q, max = 2000) {
    const s = String(q ?? '');
    if (s.length <= max) return { q: s, note: '' };
    return { q: s.slice(0, max), note: `（原句 ${s.length} 字，超过 ${max}，只按前 ${max} 字找）` };
  }

  /** 去空壳 → 词典切词；分数按词算，不按单字算。名字整词保护。 */
  askRawTerms(q) {
    // 2026-11-25：内核再兜一层，防止别的调用方绕过工具层闸门。
    q = String(q ?? '').slice(0, 4000);
    const names = this.askRawNames();
    const quoted = [];
    for (const m of String(q || '').matchAll(/[「『“"《]([^」』”"》]{1,24})[」』”"》]/g)) {
      const t = m[1].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (t && !quoted.includes(t)) quoted.push(t);
    }
    let s = String(q || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    s = ' ' + s.replace(/\s+/g, ' ') + ' ';
    for (const p of XiMemoryWorld.ASKRAW_PHRASES) s = s.split(p).join(' ');

    const out = [];
    // 词表条数上限：正常问句出不了 20 个词；超长问句切出几百个词会让全库打分变成分钟级。
    const TERM_CAP = 64;
    for (const t of segmentText(s, names)) {
      if (out.length >= TERM_CAP) break;
      if (t.length < 2) continue;
      if (/^[a-z0-9]+$/.test(t)) { if (!out.includes(t)) out.push(t); continue; }
      if (XiMemoryWorld.ASKRAW_STOPWORDS.has(t)) continue;
      if (!out.includes(t)) out.push(t);
    }
    // 引号/书名号里的词是一个整体（「断口」「翻车」《家：后日谈》），不拆
    for (const t of quoted) {
      if (out.length >= TERM_CAP) break;
      if (t.length >= 2 && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /** 词典切不出来的相邻双字实词（破甲/抽帧/穿搭这类），按全库 df 只补
   *  真的在原话里出现过的，且最多三条；只用于补召回，不碰分词器本身。 */
  askRawExtraTerms(q, baseTerms, rows) {
    // 只在原句真正相邻的两个字母/数字/汉字之间取双字；跨标点/书名号不取，
    // 避免「看完《家》」拼出「完家」。词典里已有的词也不补：分词器没切出来
    // 是因为它被停用词/单字规则收掉了，再补回去只会加噪声（如「看完」）。
    const orig = String(q || '').normalize('NFKC').toLowerCase();
    const norm = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const got = [];
    const seen = new Set();
    for (let i = 0; i + 1 < orig.length; i++) {
      const pair = orig.slice(i, i + 2);
      if (!/^[\p{L}\p{N}]{2}$/u.test(pair)) continue;
      if (XiMemoryWorld.ASKRAW_EXTRA_HEAD_STOP.has(pair[0])) continue;
      if (seen.has(pair)) continue;
      seen.add(pair);
      if (XiMemoryWorld.ASKRAW_STOPWORDS.has(pair)) continue;
      if ([...pair].some((ch) => XiMemoryWorld.ASKRAW_STOPCH.has(ch))) continue;
      if (isDictWord(pair)) continue;
      if (baseTerms.some((t) => t.includes(pair))) continue;
      // 只补「两个字的边界都不落在已有实词里」的双字：避免把「关于」的
      // 「于」和「破」拼成「于破」、「新宿」的「宿」和「决战」的「决」拼成「宿决」。
      if (baseTerms.some((t) => t.includes(pair[0]) || t.includes(pair[1]))) continue;
      let d = 0;
      for (const r of rows) if (norm(r.text).includes(pair)) d++;
      // 只补「生僻到分词器没收录」的双字：像「群里」这种全库几百行的常用词
      // 补进来只会把同分候选摊平，不解决实词被削的问题。
      if (!d || d > 50) continue;
      got.push({ pair, d });
    }
    return got.sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.pair);
  }

  askRawDate(q, now = Date.now()) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const today = fmt.format(new Date(now));
      const add = (n) => { const t = new Date(today + 'T12:00:00+08:00'); t.setDate(t.getDate() + n); return fmt.format(t); };
      let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(q);
      if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      m = /(\d{1,2})\s*[-月\/.]\s*(\d{1,2})/.exec(q);
      if (m) return `${today.slice(0, 4)}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      if (/前天/.test(q)) return add(-2);
      if (/昨天|昨晚/.test(q)) return add(-1);
      if (/今天|今晚|今早/.test(q)) return today;
      return null;
    } catch (e) { this.logError('askRawDate', e); return null; }
  }

  askRawWhen(row) {
    const note = row.note || {};
    // 出处是 raw-log.jsonl 本身的行：时间只能取它自己的 ts，按本地时报。
    // 采集时刻（tsKind=collected）不算说话时间，跟 .md 那条路一个规矩。
    if (note.jsonl) {
      const ts = String(row.ts || '');
      if (!ts || String(row.tsKind) === 'collected') return { 发生时刻: '不知道', 时刻来源: 'raw-log.jsonl 行，ts 不作数' };
      const d = new Date(ts);
      if (!Number.isFinite(d.getTime())) return { 发生时刻: '不知道', 时刻来源: 'raw-log.jsonl 行，ts 认不出' };
      const local = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(d).replace('T', ' ');
      return { 发生时刻: local, 时刻来源: 'raw-log.jsonl 的 ts（本地）' };
    }
    const at = this.lineTime(note);
    if (note.hm && at && at.local) return { 发生时刻: at.local, 时刻来源: at.why || 'note.hm（推导；非采集时刻）' };
    if (String(row.tsKind) === 'collected') return { 发生时刻: '不知道', 时刻来源: 'tsKind=collected（不采用）' };
    if (at && at.local) return { 发生时刻: at.local, 时刻来源: at.why || 'note 段落头 **HH:MM**' };
    return { 发生时刻: '不知道', 时刻来源: '无出处' };
  }

  /** 序数题的结构候选：只扫有出处的原话行，不拿没 note 的顶。 */
  askRawOrdinalHits(q, terms, rows) {
    if (!/第几条/.test(q) || !/(不看了|腻|停了|看不下去了)/.test(q)) return [];
    const topic = (terms || []).find((t) => t.length >= 2 && !/第|条/.test(t));
    const out = [];
    for (const r of rows) {
      if (!(r.note && r.note.file && r.note.lines)) continue;
      const t = String(r.text || '');
      const m = /第([一二三四五六七八九十百0-9]+)条/.exec(t);
      if (!m) continue;
      if (!/(腻|不看了|不想看了|不追了|停了(?!一下))/.test(t)) continue;
      if (topic && !t.includes(topic)) continue;
      out.push({ r, score: 1, dist: 0, lenScore: 100, sameTurn: false, seedAnswer: false,
        structLabel: '序数+停止', structExtra: { 序数: m[1] } });
    }
    return out;
  }

  /** 结构标签命中（只按候选原文判，不按分数猜）。 */
  askRawStructHits(q, x) {
    const t = String((x && x.r && x.r.text) || '');
    const hits = XiMemoryWorld.ASKRAW_STRUCTS
      .filter((s) => s.q.test(q) && s.test(t))
      .map((s) => ({ label: s.label, layer: s.layer, rangeTerm: s.rangeTerm }));
    if (x && x.structLabel && !hits.some((h) => h.label === x.structLabel)) {
      hits.push({ label: x.structLabel, ...(x.structExtra || {}) });
    }
    return hits;
  }

  /** 同一个人把同一段话重发一遍：合并，不占两个候选位。 */
  askRawMergeReposts(scored) {
    const lcs = (a, b) => {
      const A = String(a || ''), B = String(b || '');
      let best = 0, prev = new Array(B.length + 1).fill(0);
      for (let i = 1; i <= A.length; i++) {
        const cur = new Array(B.length + 1).fill(0);
        for (let j = 1; j <= B.length; j++) {
          if (A[i - 1] === B[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
        }
        prev = cur;
      }
      return best;
    };
    const spKey = (x) => String((x.r.speaker && (x.r.speaker.id ?? x.r.speaker.name)) ?? '');
    const out = [];
    for (const x of scored) {
      const t = String(x.r.text || '');
      if (/刚被拦了一次|重发/.test(t)) {
        const y = out.find((o) => spKey(o) === spKey(x) && lcs(o.r.text, t) >= 80);
        if (y) {
          y.merged = [...(y.merged || []), `${x.r.note.file}:${x.r.note.lines}`];
          continue;
        }
      }
      out.push(x);
    }
    return out;
  }

  /** 结构升级时补出口字段：范围、层次、序数。 */
  askRawStructMeta(x, q) {
    const h = (x && x.structHits && x.structHits[0]) || {};
    const out = { 结构升级: true, 结构标签: h.label || '结构唯一' };
    if (h.layer) out.层次 = h.layer;
    if (h.rangeTerm) {
      try {
        const file = x.r.note.file;
        const ln = parseInt(String(x.r.note.lines), 10);
        const lines = readFileSync(join(this.botDir, 'workspace', file), 'utf8').split(String.fromCharCode(10));
        let first = 0;
        for (let i = 0; i < Math.min(lines.length, ln); i++) {
          if (String(lines[i] || '').includes(h.rangeTerm)) { first = i + 1; break; }
        }
        if (first && first < ln) {
          out.出处 = `${file}:${first}-${ln}`;
          out.说明 = `词首次出现在 ${first}，这里（${ln}）是定义式回答`;
        }
      } catch (e) { this.logError('askRaw:structRange', e); }
    }
    if (x.structExtra && x.structExtra.序数) {
      const s = String(x.structExtra.序数);
      const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      let n = /^\d+$/.test(s) ? Number(s) : NaN;
      if (!Number.isFinite(n) && s.includes('十')) {
        const [a, b] = s.split('十');
        n = (a ? (d[a] ?? 0) : 1) * 10 + (b ? (d[b] ?? 0) : 0);
      } else if (!Number.isFinite(n)) n = d[s];
      out.序数 = Number.isFinite(n) ? n : s;
    }
    if (x.merged) out.合并出处 = x.merged;
    if (h.layer === '事后复述') out.说明 = '这是事后复述，不是原现场';
    return out;
  }

  /** 一问一答：显式路径，不自动判断问句是不是在问回应。
   *  条件四条：种子之后、说者换人、只许跨一个段头、中间最多隔两条消息。 */
  askRawPair(seedRow) {
    const file = seedRow && seedRow.note && seedRow.note.file;
    const seedLine = parseInt(String((seedRow && seedRow.note && seedRow.note.lines) || ''), 10);
    const pack = (row) => {
      const when = this.askRawWhen(row);
      const note = row.note && row.note.file && row.note.lines ? `${row.note.file}:${row.note.lines}` : null;
      const sp = row.speaker || {};
      return {
        答案: String(row.text || ''),
        说者: sp.name || '未知',
        说者号: sp.id ?? null,
        出处: note,
        发生时刻: when.发生时刻,
        时刻来源: when.时刻来源,
      };
    };
    if (!file || !Number.isFinite(seedLine)) {
      return { 结果: 'empty-miss', 原因: '种子没有出处，不能配回应', 种子: pack(seedRow) };
    }
    let rows;
    try {
      rows = this.readRows().filter((r) => r && r.text && r.note && r.note.file === file);
    } catch (e) {
      this.logError('askRawPair:readRows', e);
      return { 结果: 'refused-nosource', 原因: '原话库读不开' };
    }
    const byLine = new Map();
    for (const r of rows) {
      const ln = parseInt(String((r.note && r.note.lines) || ''), 10);
      if (Number.isFinite(ln) && !byLine.has(ln)) byLine.set(ln, r);
    }
    let lines;
    try {
      lines = readFileSync(join(this.botDir, 'workspace', file), 'utf8').split(String.fromCharCode(10));
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.logError('askRawPair:file', e);
      return { 结果: 'refused-nosource', 原因: '种子出处读不开', 种子: pack(seedRow) };
    }
    const spKey = (sp) => String((sp && (sp.id ?? sp.name)) ?? '');
    const seedKey = spKey(seedRow.speaker);
    const isMedia = (x) => /^\s*\[图片\]|\[blob\s/.test(String((x && x.text) || ''));
    let headers = 0, between = 0, response = null;
    for (let ln = seedLine + 1; ln <= lines.length; ln++) {
      const line = lines[ln - 1] || '';
      if (/^\*\*\s*\d{1,2}:\d{2}\s*\*\*/.test(line)) {
        headers++;
        if (headers > 1) break;
        continue;
      }
      const row = byLine.get(ln);
      if (!row || isMedia(row)) continue;
      if (spKey(row.speaker) === seedKey) {
        between++;
        if (between > 2) break;
        continue;
      }
      response = row;
      break;
    }
    if (!response) {
      return { 结果: 'empty-miss', 原因: '种子之后没有符合条件的回应', 种子: pack(seedRow), 隔几条消息: between, 跨段头: headers };
    }
    return { 结果: 'pair', 种子: pack(seedRow), 回应: pack(response), 隔几条消息: between, 跨段头: headers };
  }

  askRaw(q, conv, askedAt, opts = {}) {
    // 2026-11-25：内核兜底。工具层已截断，这里防 qqbot 等别的调用方直接灌长文本。
    const question = String(q ?? '').slice(0, 4000).trim();
    const version = (this.askScope() || {}).criteriaVersion || 'unknown';
    if (!question) return JSON.stringify({ 结果: 'empty-miss', 原因: '没有问句', 版本: version });
    // 相对日期绑「问句时刻」，不绑跑的那天；不传才默认现在。
    let askedMs = Date.now();
    if (askedAt !== undefined && askedAt !== null && askedAt !== '') {
      const t = typeof askedAt === 'number' ? askedAt : Date.parse(String(askedAt));
      if (Number.isFinite(t)) askedMs = t;
    }
    const askedIso = new Date(askedMs).toISOString();
    const selfQq = this.selfQq();
    const masterQq = this.masterQq();
    const privateToMaster = String(conv || '') === 'private:' + masterQq;
    const asksSelf = /我说过|我说|我讲|我问|我提|我哪|我什么时候|我自己/.test(question);
    const asksOther = /他(?:说过|说|讲|问|提)|他.{0,10}(?:说|回|答|问|讲|提)/.test(question);

    let rows;
    try { rows = this.readRows().filter((r) => r && r.text && !r.duplicateOf); } catch (e) {
      this.logError('askRaw:readRows', e);
      return JSON.stringify({ 结果: 'refused-nosource', 原因: '原话库读不开', 版本: version });
    }
    const isSelf = (sp) => sp && (sp.id === 'self' || String(sp.id) === String(selfQq) || sp.name === '我');
    const isMaster = (sp) => sp && String(sp.id) === String(masterQq);

    // ── 2026-11-21 20:5x：raw-log.jsonl 里有一大批行没有 .md 出处 ──
    // qq-sent / live-backfill / mem-merge / 部分 factstore 这些行的 note.file 是空的，
    // 而窗口那一步原来写死 `if (!f || !Number.isFinite(ln)) continue`，它们等于从没被翻过。
    // 这里给它们一条自己的出处：raw-log.jsonl:行号；窗口按「同一会话里相邻的若干行」取。
    const JSONL_WINDOW = 12;
    const convKeyOf = (r) => String(r.conv
      || `${r.scene || '?'}|${(r.speaker && (r.speaker.id ?? r.speaker.name)) || '?'}`);
    const byConv = new Map();
    rows.forEach((r, i) => {
      const hasNote = r.note && r.note.file && Number.isFinite(parseInt(String(r.note.lines || ''), 10));
      if (!hasNote) {
        r.note = Object.assign({}, r.note, { file: 'raw-log.jsonl', lines: String(i + 1), jsonl: true });
      }
      const k = convKeyOf(r);
      if (!byConv.has(k)) byConv.set(k, []);
      byConv.get(k).push(r);
    });

    // 说者先不筛：问「他怎么回」时，命中的往往是我那句，得靠相邻窗口带出他的回话。
    let cand = rows;
    const date = this.askRawDate(question, askedMs);
    let dateNotice = null;
    if (date) {
      const byDate = cand.filter((r) => String((r.note && r.note.file) || '').includes(date));
      if (byDate.length) cand = byDate;
      else dateNotice = '时间过滤未命中，已退回全库';
    }

    let terms = this.askRawTerms(question);
    if (!terms.length) return JSON.stringify({ 结果: 'empty-miss', 原因: '问句里没有可翻的实词', 问了时刻: askedIso, 版本: version });
    const norm = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const extraTerms = this.askRawExtraTerms(question, terms, rows).filter((t) => !terms.includes(t));
    if (extraTerms.length) terms = terms.concat(extraTerms);

    // IDF：罕见词加权，常见词降权。df 在全库原话上算，避免候选集小的时候权重乱跳。
    const N = rows.length;
    const df = new Map();
    for (const t of terms) {
      let d = 0;
      for (const r of rows) if (norm(r.text).includes(t)) d++;
      df.set(t, d);
    }
    const weight = new Map(terms.map((t) => [t, Math.log((N + 1) / (df.get(t) + 1)) + 1]));
    const totalWeight = terms.reduce((s, t) => s + weight.get(t), 0);
    const avgLen = rows.reduce((s, r) => s + String(r.text || '').length, 0) / Math.max(1, rows.length);
    const hitsOf = (text) => {
      let m = 0, w = 0; const hit = new Set();
      for (const t of terms) if (text.includes(t)) { m++; w += weight.get(t); hit.add(t); }
      return { m, w, hit };
    };

    const lineOf = (r) => parseInt(String((r.note && r.note.lines) || ''), 10);
    const byFile = new Map();
    for (const r of rows) {
      const f = r.note && r.note.file;
      const ln = lineOf(r);
      if (!f || !Number.isFinite(ln)) continue;
      if (!byFile.has(f)) byFile.set(f, new Map());
      const m = byFile.get(f);
      if (!m.has(ln)) m.set(ln, r);
    }

    const seeds = [];
    for (const r of cand) {
      const h = hitsOf(norm(r.text));
      if (h.m) seeds.push({ r, h });
    }
    // 事实型问句：调用方显式传 fact=true 时，允许「种子本身」就是答案。
    // 这里只认整句命中权重最高的那条有出处的种子，不跟 1.5 倍线较劲。
    const factPick = seeds.filter((s) => s.r.note && s.r.note.file && s.r.note.lines)
      .slice().sort((a, b) => b.h.w - a.h.w || lineOf(a.r) - lineOf(b.r))[0] || null;
    // 日期过滤后一个都没命中，就退回全库；出口必须把这次退回写出来。
    if (!seeds.length && date && cand !== rows) {
      cand = rows;
      dateNotice = '时间过滤未命中，已退回全库';
      for (const r of cand) {
        const h = hitsOf(norm(r.text));
        if (h.m) seeds.push({ r, h });
      }
    }

    // 相邻窗口：同一段落头（**HH:MM**）为一个窗口，前后各放宽三行。
    // 这样「她说完、他回一句」能落在同一窗里；同一段只出一个候选，不拿同段三行占三个名额。
    const secCache = new Map();
    const sectionsOf = (f) => {
      if (secCache.has(f)) return secCache.get(f);
      const secs = [];
      try {
        const lines = readFileSync(join(this.botDir, 'workspace', f), 'utf8').split(String.fromCharCode(10));
        let cur = null;
        for (let i = 0; i < lines.length; i++) {
          if (/^\*\*\s*\d{1,2}:\d{2}\s*\*\*/.test(lines[i] || '')) {
            if (cur) cur.end = i;
            cur = { start: i + 1, end: lines.length };
            secs.push(cur);
          }
        }
      } catch (e) { if (e && e.code !== 'ENOENT') this.logError('askRaw:sections', e); }
      secCache.set(f, secs);
      return secs;
    };
    const sectionOf = (f, ln) => {
      const secs = sectionsOf(f);
      for (let i = secs.length - 1; i >= 0; i--) {
        if (secs[i].start <= ln && ln <= secs[i].end) return secs[i];
      }
      return null;
    };

    const windows = new Map();
    const bySection = new Map();
    for (const s of seeds) {
      const f = s.r.note && s.r.note.file;
      const ln = lineOf(s.r);
      if (!f || !Number.isFinite(ln)) continue;
      const sec = sectionOf(f, ln);
      const key = `${f}:${sec ? sec.start : ln}`;
      const cur = bySection.get(key) || { f, sec, ln, seeds: [] };
      cur.seeds.push(s);
      bySection.set(key, cur);
    }

    for (const grp of bySection.values()) {
      const { f, sec } = grp;
      let lo = grp.ln - 3, hi = grp.ln + 3;
      if (sec) { lo = sec.start; hi = sec.end; }
      let wrows = [];
      const firstSeed = grp.seeds.slice().sort((a, b) => b.h.w - a.h.w || lineOf(a.r) - lineOf(b.r))[0].r;
      if (firstSeed.note && firstSeed.note.jsonl) {
        // 没有 .md 出处的行：窗口取同一会话里它前后各 JSONL_WINDOW 行，不按文件行号 ±3。
        const arr2 = byConv.get(convKeyOf(firstSeed)) || [];
        const pos = arr2.indexOf(firstSeed);
        if (pos >= 0) wrows = arr2.slice(Math.max(0, pos - JSONL_WINDOW), pos + JSONL_WINDOW + 1);
      } else if (byFile.has(f)) {
        const m = byFile.get(f);
        for (let k = lo; k <= hi; k++) if (m.has(k)) wrows.push(m.get(k));
      }
      if (!wrows.length) continue;
      const wh = hitsOf(norm(wrows.map((x) => x.text).join(' ')));
      if (!wh.m) continue;

      // 这个段里命中最重的那句当种子；同重取最早，不猜。
      const bestSeed = grp.seeds.slice().sort((a, b) => b.h.w - a.h.w || lineOf(a.r) - lineOf(b.r))[0];
      const sl = lineOf(bestSeed.r);
      const seedText = String(bestSeed.r.text || '').trim();
      const seedIsQ = /[?？]\s*$|[吗呢]\s*$/.test(seedText) ||
        /^(什么|啥|谁|哪|怎么|多少|是不是|有没有|记不记得)/.test(seedText);
      const after = (x) => lineOf(x) > sl;
      // 三条硬条件：答案必须在种子之后、必须在同一段、并列按离种子最近排。
      // 离得一样远就出两条候选，不拿分数或时间硬拉。
      const isGroup = /^group:/.test(String(conv || ''));
      const isMedia = (x) => /^\s*\[图片\]|\[blob\s/.test(String((x && x.text) || ''));
      let candidates = [];
      const hasAfter = wrows.some((x) => after(x) && !isMedia(x));
      const seedSelf = isSelf(bestSeed.r.speaker);
      let pool = [];
      if (asksOther && privateToMaster) {
        pool = wrows.filter((x) => after(x) && !isMedia(x) && isMaster(x.speaker));
      } else if (seedSelf) {
        pool = wrows.filter((x) => after(x) && !isMedia(x) && ((asksSelf || !seedIsQ) ? isSelf(x.speaker) : isMaster(x.speaker)));
        // 例外：种子本身是陈述句，且同段、种子之后确实一行候选都没有时，
        // 允许种子自己当答案；只在回显，报数单独一栏，不算「认出」。
        if (!hasAfter && !seedIsQ) candidates = [bestSeed.r];
      } else {
        pool = wrows.filter((x) => after(x) && !isMedia(x) && isSelf(x.speaker));
      }
      if (!candidates.length) candidates = pool;
      if (!candidates.length) continue;
      // 2026-11-22 01:1x 我：把问句原话抄了一遍的行，是在「谈这个问题」，不是在答它。
      // 我每次跟你讨论评测，都会把问题连答案一起复述；那些行比原话更近、更长、覆盖更全，
      // 于是把真答案顶掉（k165 就是被我 00:52 那条自己发的顶掉的）。这类行直接不进答案位。
      const qNorm = norm(question);
      const quoting = (text) => {
        if (qNorm.length < 8) return false;
        const t = norm(String(text || ''));
        for (let i = 0; i + 8 <= qNorm.length; i++) {
          if (t.includes(qNorm.slice(i, i + 8))) return true;
        }
        return false;
      };
      for (const answer of candidates) {
        if (quoting(answer.text)) continue;
        const note = answer.note && answer.note.file && answer.note.lines
          ? `${answer.note.file}:${answer.note.lines}` : null;
        // 一轮话算一个窗口：同段里同一说者连续的几句合起来打分，
        // 不拿「离种子最近」当判据，也不拿邻居的话给单句抬分。
        const idx = wrows.indexOf(answer);
        let a = idx, b = idx;
        const spKey = (x) => String((x.speaker && (x.speaker.id ?? x.speaker.name)) ?? '');
        while (a > 0 && spKey(wrows[a - 1]) === spKey(answer)) a--;
        while (b + 1 < wrows.length && spKey(wrows[b + 1]) === spKey(answer)) b++;
        const turnRows = wrows.slice(a, b + 1);
        const turnText = turnRows.map((x) => String(x.text || '')).join(' ');
        // 2026-11-22 01:1x 我：原来按「同一说者相连的一整轮」合起来打分，
        // 一轮越长覆盖越全，分数几乎必然顶到 1；一到 1 就靠 lenScore 决胜，
        // 于是永远是最短的那句赢（「嗯，明天见。」「该睡了。」）。
        // 改成只量这句话本身——候选是句子，评的也该是句子。
        const th = hitsOf(norm(String(answer.text || '')));
        const cover = totalWeight ? th.w / totalWeight : 0;
        // 2026-11-22 01:2x 我：覆盖率高不等于答对——我发给他的长段汇报里什么词都出现过，
        // 几百字的块必然覆盖全部实词，覆盖率恒等于 1，于是所有长块并列。
        // 按长度归一（BM25 的写法）：同样的覆盖率，句子越长分越低。
        const dlHere = String(answer.text || '').length;
        const lenNorm = 1 / (1 + 0.5 * (dlHere / Math.max(1, avgLen)));
        const score = cover * lenNorm;
        const dist = lineOf(answer) - sl;
        const dl = String(answer.text || '').length;
        const lenScore = 1 / (0.25 + 0.75 * (dl / Math.max(1, avgLen)));
        const key = `${f}:${lineOf(answer)}`;
        const prev = windows.get(key);
        if (!prev || score > prev.score) {
          windows.set(key, { r: answer, seed: bestSeed.r, score, cover, dist, lenScore,
            sameTurn: turnRows.length > 1,
            seedAnswer: answer === bestSeed.r,
            turnFrom: lineOf(turnRows[0]), turnTo: lineOf(turnRows[turnRows.length - 1]),
            m: th.m, hit: th.hit });
        }
      }
    }

    // 序数题：按「第N条」结构补一条候选（只有一条时才算结构唯一）。
    for (const x of this.askRawOrdinalHits(question, terms, rows)) {
      const k = `${x.r.note.file}:${x.r.note.lines}`;
      windows.set(k, x);
    }
    const dedup = new Set();
    const scoredRaw = [...windows.values()].sort((a, b) =>
      b.score - a.score || b.lenScore - a.lenScore || a.dist - b.dist)
      .filter((x) => {
        const n = x.r.note && x.r.note.file && x.r.note.lines ? `${x.r.note.file}:${x.r.note.lines}` : `x:${x.r.ts}`;
        if (dedup.has(n)) return false;
        dedup.add(n);
        return true;
      });
    const scored = this.askRawMergeReposts(scoredRaw);
    const top5 = scored.slice(0, 5);
    const answerable = scored.filter((x) => x.r.note && x.r.note.file && x.r.note.lines);
    const withheld = scored.length - answerable.length;
    for (const x of scored) x.structHits = this.askRawStructHits(question, x);

    const pack = (x) => {
      const when = this.askRawWhen(x.r);
      const note = x.r.note && x.r.note.file && x.r.note.lines ? `${x.r.note.file}:${x.r.note.lines}` : null;
      const sp = x.r.speaker || {};
      return {
        答案: String(x.r.text),
        说者: sp.name || '未知',
        说者号: sp.id ?? null,
        出处: note,
        发生时刻: when.发生时刻,
        分数: Number(x.score.toFixed(2)),
        '答案=种子本身': !!x.seedAnswer,
        命中来自同一轮: !!x.sameTurn,
        轮行号: x.sameTurn ? `${x.turnFrom}-${x.turnTo}` : null,
        ...(x.structHits && x.structHits.length ? { 结构命中: x.structHits.map((h) => h.label) } : {}),
        ...(x.merged ? { 合并出处: x.merged } : {}),
        ...(note ? {} : { 备注: '无出处' }),
      };
    };

    const extra = { 问了时刻: askedIso, ...(dateNotice ? { 时间过滤: dateNotice } : {}) };
    if (process.env.XI_RAW_DEBUG) {
      extra.词 = terms;
      extra.权重 = Object.fromEntries(terms.map((t) => [t, Number(weight.get(t).toFixed(2))]));
    }
    if (!scored.length) {
      return JSON.stringify({ 结果: 'empty-miss', 原因: '原话库里没有命中这句的', ...extra, 候选: [], 版本: version });
    }
    // 一问一答只在调用方显式传 pair=true 时走；系统不猜「这句是不是在问回应」。
    if (opts && opts.pair) {
      let seedRow = null;
      if (opts.seed) {
        const raw = String(opts.seed);
        const i = raw.lastIndexOf(':');
        const sf = i >= 0 ? raw.slice(0, i) : '';
        const sl = i >= 0 ? raw.slice(i + 1) : '';
        seedRow = rows.find((r) => r.note && r.note.file === sf && String(r.note.lines) === String(sl)) || null;
      } else {
        // 种子按问句里的「我」筛说者，再按命中权重取；不从答案位反推种子。
        const seedPool = asksSelf ? seeds.filter((s) => isSelf(s.r.speaker)) : seeds;
        const pick = (seedPool.length ? seedPool : seeds).slice()
          .sort((a, b) => b.h.w - a.h.w || lineOf(a.r) - lineOf(b.r))[0];
        seedRow = pick ? pick.r : null;
      }
      if (!seedRow) {
        return JSON.stringify({ 结果: 'empty-miss', 原因: '没有找到可配回应的种子', ...extra, 版本: version });
      }
      const pair = this.askRawPair(seedRow);
      return JSON.stringify({ ...pair, 问了时刻: askedIso, 版本: version });
    }
    // 事实型问句（调用方显式传 fact=true）：种子本身就是答案。
    // 不跟 1.5 倍较劲，也不让「答案必须在种子之后」这条把陈述句挡掉；
    // 只要求种子有出处、且不是问句。与 pair 是两条路，系统不自动判断题型。
    if (opts && opts.fact) {
      if (!factPick) {
        return JSON.stringify({
          结果: 'refused-nosource',
          原因: '没有带出处的种子，进不了事实答案位',
          ...extra, 候选: top5.map(pack), 版本: version,
        });
      }
      const seedText = String(factPick.r.text || '').trim();
      // 事实题也不许拿「只命中半句」的种子顶：种子必须覆盖问句的全部实词。
      if (factPick.h.m < terms.length) {
        return JSON.stringify({
          结果: 'refused-nosource',
          原因: '种子没有覆盖问句的全部实词，不能当事实答案',
          ...extra, 候选: top5.map(pack), 版本: version,
        });
      }
      const seedQ = /[?？]\s*$|[吗呢]\s*$/.test(seedText) ||
        /^(什么|啥|谁|哪|怎么|多少|是不是|有没有|记不记得)/.test(seedText);
      if (seedQ) {
        return JSON.stringify({
          结果: 'refused-nosource',
          原因: '种子本身是问句，不能当事实答案',
          ...extra, 候选: top5.map(pack), 版本: version,
        });
      }
      const factScore = totalWeight ? factPick.h.w / totalWeight : 0;
      const packed = pack({ r: factPick.r, score: factScore, seedAnswer: true, sameTurn: false });
      return JSON.stringify({
        结果: 'answered',
        ...packed,
        答案来源: '种子本身（事实路径）',
        路径: 'fact',
        ...extra,
        版本: version,
      });
    }
    // 2026-11-21 23:5x 起、23:59 改第二版：时间题 / 出处题。
    // 问「几点说的 / 什么时候说的 / 哪天说的」时，答案就是那句原话本身加上它的时间，
    // 不是它后面那句回应。
    // 第一版要求种子命中「除时间词外的全部实词」，可问句里的「今晚」「说」在原话里根本没有，
    // 反过来把真种子卡死了（23:55 验：还是 refused 0.50）。第二版：先把要问的那段话挑出来
    // （引号里的优先），拿它自己的实词去全库找，要求每个实词都在同一行出现，
    // 整段原样出现再加一大笔；唯一最高分才答，同分就拒，不拿最像的顶。
    const whenAsk = /(几点|什么时候|啥时候|何时|哪一天|哪天|几号)/.test(question)
      && !/(怎么回|回了什么|他怎么答|她怎么答|回答了什么)/.test(question);
    if (whenAsk) {
      const qm = /[「『“"]([^」』”"]{2,60})[」』”"]/.exec(question);
      const coreW = qm ? qm[1]
        : question.replace(/(几点|什么时候|啥时候|何时|哪一天|哪天|几号|说过|说的|说|讲过|讲|问过|问)/g, ' ');
      const wTerms = this.askRawTerms(coreW)
        .filter((t) => !/(几点|什么时候|啥时候|何时|哪天|哪一天|几号|今晚|今天|昨天|那次|那天)/.test(t));
      if (wTerms.length) {
        const coreNorm = norm(coreW);
        const wdf = new Map();
        for (const t of wTerms) {
          let d = 0;
          for (const r of rows) if (norm(r.text).includes(t)) d++;
          wdf.set(t, d);
        }
        const wScore = [];
        for (const r of rows) {
          const txt = norm(r.text);
          if (!txt) continue;
          if (!wTerms.every((t) => txt.includes(t))) continue;
          let w = wTerms.reduce((sum, t) => sum + Math.log((N + 1) / (wdf.get(t) + 1)) + 1, 0);
          if (coreNorm && txt.includes(coreNorm)) w += 50;
          wScore.push({ r, w });
        }
        wScore.sort((a, b) => b.w - a.w || lineOf(b.r) - lineOf(a.r));
        const bestW = wScore[0];
        const secondW = wScore[1];
        if (bestW && !(secondW && Math.abs(secondW.w - bestW.w) < 1e-9)) {
          const whenW = this.askRawWhen(bestW.r);
          const noteW = `${bestW.r.note.file}:${bestW.r.note.lines}`;
          const spW = bestW.r.speaker || {};
          this.logAsk({ 原句: question, 类别: 'raw', 版本: version, at: new Date().toISOString(), 答案: String(bestW.r.text), 行号: noteW, 结果: 'answered', 候选数: wScore.length, 路径: 'raw-when', 发生时刻: whenW.发生时刻, 问了时刻: askedIso });
          return JSON.stringify({
            结果: 'answered',
            答案: String(bestW.r.text).trim(),
            说者: spW.name || '未知',
            说者号: spW.id ?? null,
            出处: noteW,
            发生时刻: whenW.发生时刻,
            时刻来源: whenW.时刻来源,
            '答案=种子本身': true,
            答案来源: '种子本身（时间题）',
            路径: 'raw-when',
            命中来自同一轮: false,
            轮行号: null,
            同分候选: wScore.length,
            ...extra, 候选: top5.map(pack), 版本: version,
          });
        }
      }
    }
    if (!answerable.length) {
      return JSON.stringify({
        结果: 'refused-nosource',
        原因: '命中的原话都没有出处，进不了答案位',
        ...extra, 候选: top5.map(pack), 未定源: withheld, 版本: version,
      });
    }
    // 结构唯一性：候选里命中结构标签的恰好一条，才升认出；零条/多条仍报多解。
    const tagged = answerable.filter((x) => x.structHits && x.structHits.length);
    const upgraded = tagged.length === 1 ? tagged[0] : null;
    const best = upgraded || answerable[0];
    const second = answerable.find((x) => x !== best) || null;
    if (!upgraded && best.seedAnswer && answerable.length === 1) {
      return JSON.stringify({
        结果: 'empty-miss',
        原因: '没翻到别的，只有你问的那句本身',
        回显: true,
        ...extra, 候选: top5.map(pack), 版本: version,
      });
    }
    const when = this.askRawWhen(best.r);
    const note = `${best.r.note.file}:${best.r.note.lines}`;
    const sp = best.r.speaker || {};
    const structMeta = upgraded ? this.askRawStructMeta(best, question) : {};
    const base = {
      结果: 'answered', 答案: String(best.r.text), 说者: sp.name || '未知', 说者号: sp.id ?? null,
      出处: note, 发生时刻: when.发生时刻, 时刻来源: when.时刻来源,
      '答案=种子本身': !!best.seedAnswer,
      答案来源: best.seedAnswer ? '种子本身' : '种子之后',
      命中来自同一轮: !!best.sameTurn,
      轮行号: best.sameTurn ? `${best.turnFrom}-${best.turnTo}` : null,
      ...structMeta,
      ...extra, 候选: top5.map(pack), 版本: version,
    };
    if (upgraded) {
      this.logAsk({ 原句: question, 类别: 'raw', 版本: version, at: new Date().toISOString(), 答案: String(best.r.text), 行号: note, 结果: 'answered', 候选数: top5.length, 路径: 'raw-struct', 升级: '结构唯一', 发生时刻: when.发生时刻, 问了时刻: askedIso });
      return JSON.stringify(base);
    }
    // 闸门看覆盖率（内容在不在），排序看归一分（准不准）。两者别混。
    if ((best.cover ?? best.score) < 0.6) {
      // 2026-11-25 00:5x 压测发现：这条以前是 { ...base, 结果:'refused-nosource' }，
      // base 里带着 答案/说者/出处——下半段明说分数不够不能用，上半段却把那条原话
      // 摆在「答案」位上，读的人照着一引用就越线。拒就是拒：答案位留空，只给候选和分数。
      return JSON.stringify({
        结果: 'refused-nosource',
        原因: `最高只有 ${Number(best.cover ?? best.score).toFixed(2)}，不到 0.6`,
        ...extra, 候选: top5.map(pack), 版本: version,
      });
    }
    if (second && best.score < second.score * 1.5) {
      // 同理：拉不开 1.5 倍是「两条都像」，不把第一条抬成答案。
      return JSON.stringify({
        结果: 'ambiguous',
        原因: `第一${best.score.toFixed(2)} 第二${second.score.toFixed(2)}，拉不开 1.5 倍`,
        ...extra, 候选: top5.map(pack), 版本: version,
      });
    }
    this.logAsk({ 原句: question, 类别: 'raw', 版本: version, at: new Date().toISOString(), 答案: String(best.r.text), 行号: note, 结果: 'answered', 候选数: top5.length, 路径: 'raw', 发生时刻: when.发生时刻, 问了时刻: askedIso });
    return JSON.stringify(base);
  }

  /** 对外问值：只接三类，答不出返空，绝不说「想不起来」。 */
  /**
   * 对外只有五档（总纲 §三；我 11-14 20:04 定）：answer / unrecognized / nosource / unverified / expired，
   * 外加 error（回答层自己坏了，不并进五档）。
   * 内部那一堆名字是**为什么**，不是**是哪一档**——留在 code 里，别让调用方去猜该补问法还是补事实。
   *   refused-nosource → unrecognized + no-question-keys（她 19:38 定的：库里这条有、没挂问法、取不到）
   *   empty-miss / missing-fact / nosource-mine → nosource（三个不同原因，code 各自留名）
   *   unverified / inconsistent → unverified
   *   ambiguous → unrecognized + ambiguous（分不清问的是哪条，不是没记过）
   */
  ask(args) {
    // 2026-11-25：同一道长度闸的兜底（工具层 capQuery 已截，防别的调用方绕过）。
    if (args && typeof args.question === 'string' && args.question.length > 4000) {
      args = { ...args, question: args.question.slice(0, 4000) };
    }
    // askInner 里有十几处 logAsk，不是每处都带 conv。在这里记一次，给 logAsk 兜底——
    // 判据只在一个地方判，不指望每个调用点自己记得传东西（今晚第二次栽在这上面）。
    const askKind = (args && args.kind) || 'manual';
    this.currentConv = this.resolveConv(args);
    this.currentKind = askKind;
    let raw;
    try { raw = this.askInner(args); } finally { this.currentConv = ''; this.currentKind = ''; }
    if (typeof raw !== 'string') return raw;
    let o;
    try { o = JSON.parse(raw); } catch { return raw; }   // 早退那几句是人话，原样给
    if (!o || typeof o !== 'object' || !o['结果']) return raw;
    const MAP = {
      answered: ['answer', null],
      'downgraded-ask': ['answer', 'need-permission'],
      'kept-strict': ['unverified', 'kept-strict'],
      ambiguous: ['unrecognized', 'ambiguous'],
      inconsistent: ['unverified', 'inconsistent'],
      expired: ['expired', null],
      'nosource-mine': ['nosource', 'no-evidence'],
      unverified: ['unverified', 'pending-verify'],
      'empty-miss': ['nosource', 'empty-miss'],
      'missing-fact': ['nosource', 'missing-fact'],
      'refused-nosource': ['unrecognized', 'no-question-keys'],
      'refused-scope': ['unrecognized', 'out-of-scope'],
      error: ['error', 'internal'],
    };
    // 缺口账要赶在 MAP 之前记：unrecognized 这类没有映射分支，不能因此漏账。
    if (askKind === 'manual' && !['answered', 'downgraded-ask'].includes(String(o['结果'] || ''))) {
      try {
        recordGap({
          storeDir: this.storeDir, kind: 'ask',
          question: String((args && args.question) || '').slice(0, 240),
          conv: String((args && args.conv) || ''),
          result: String(o['结果'] || ''),
          detail: String(o.code || o['原因'] || '').slice(0, 200),
        });
      } catch (e) { this.logError('recordGap:ask', e); }
      try {
        autoLessonFromFailure({
          storeDir: this.storeDir, kind: 'ask',
          question: String((args && args.question) || '').slice(0, 240),
          conv: String((args && args.conv) || ''),
          detail: String(o.code || o['原因'] || '').slice(0, 200),
        });
      } catch (e) { this.logError('autoLesson:ask', e); }
    }
    const m = MAP[o['结果']];
    if (!m) return raw;                       // 没登记的名字原样放出去，别偷偷改名
    const out = { ...o, 结果: m[0] };
    if (m[1]) out.code = m[1];
    // empty-miss 底下压着两种完全不同的东西，不能都叫「没源」：
    //   「认不出是谁」= 我不知道你问谁 → 认不出
    //   「没挂上词」  = 我知道有这条、就是没挂问法 → 认不出（她 19:38 定的那一档）
    // 真正「库里没有」的只有 missing-fact 与无 detail 的那条。
    if (o['结果'] === 'empty-miss') {
      const why = String(o['原因'] || '');
      if (/认不出是谁|主体是代词/.test(why)) { out['结果'] = 'unrecognized'; out.code = 'no-subject'; }
      else if (/没挂上词|不按字面撞/.test(why)) { out['结果'] = 'unrecognized'; out.code = 'no-question-keys'; }
      else { out['结果'] = 'nosource'; out.code = 'empty-class'; }
    }
    // refused-scope 底下也是两件事：问的范围不该我答 vs 我没认出问的是谁。
    // 后者本来就该是 no-subject（她 19:38：认不出就是认不出，只是我们自己知道为什么）。
    if (o['结果'] === 'refused-scope' && /主体是代词/.test(String(o['原因'] || ''))) {
      out['结果'] = 'unrecognized';
      out.code = 'no-subject';
    }
    if (out['结果'] !== o['结果']) out.内码 = o['结果'];   // 排障用：改名了但说实话
    // P2 证据门（借 dsh-engram）：命中只说明相关，不说明够回答。
    // 三个条件：①有可指回的证据锚 ②没有冲突/越权 ③给的策略是「可以答」。
    out.evidenceGate = this.evidenceGateForAsk(out, String((args && args.question) || ''));
    this.logAskCitations(out, args);                        // P4：这一问端出了哪条事实
    this.noteDeskAsk(args && args.question, out);          // 桌面区 v0 第四格：记一笔本轮问过什么
    this.shadowMaybe(o, args);                            // 影子：主路已算完，异步发出去，不阻塞
    return JSON.stringify(out);
  }

  /** 会话号：调用方没给就从 raw-log 最后一条真人入站补；补不出记 unknown。 */
  resolveConv(args) {
    const given = String((args && args.conv) || '').trim();
    if (given) return given;
    try {
      const p = join(this.storeDir, 'raw-log.jsonl');
      const st = statSync(p);
      const len = Math.min(st.size, 256 * 1024);
      if (len > 0) {
        const fd = openSync(p, 'r');
        const buf = Buffer.alloc(len);
        try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
        const lines = buf.toString('utf8').split(String.fromCharCode(10));
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const s = lines[i].trim();
          if (!s) continue;
          let row;
          try { row = JSON.parse(s); } catch { continue; }
          if (!row || row.dir !== 'in' || row.duplicateOf) continue;
          const scene = String(row.scene || '');
          if (scene !== 'private' && scene !== 'group') continue;
          const sp = row.speaker || {};
          const id = String(sp.id || sp.qq || row.speakerKey || '').trim();
          if (id) return `${scene}:${id}`;
        }
      }
    } catch (e) { this.logError('resolveConv', e); }
    return 'unknown';
  }

  /**
   * P4：把「这一问实际端出了哪条事实」落一行 citation。
   * 按证据 id 记账（out.条），不再用答案文本前 12 字匹配——她通常转述，逐字匹配会把「查过」记成「没查」。
   */
  logAskCitations(out, args) {
    try {
      if (!out || String(out['结果'] || '') !== 'answer') return;
      const id = out['条'] ? String(out['条']) : '';
      if (!id) return;
      const f = (this._factById || {})[id] || {};
      logCitations(this.storeDir, {
        conv: this.resolveConv(args),
        source: 'ask',
        facts: [{ id, rawIds: Array.isArray(f.rawIds) ? f.rawIds : [] }],
        note: String((args && args.question) || '').slice(0, 80),
      });
    } catch (e) { this.logError('logAskCitations', e); }
  }

  /** 影子模式的引擎调用：懒加载一次，之后复用。只读，不写 facts、不写状态。 */
  async shadowEngine(q) {
    if (!this._engine) {
      const dir = String(process.env.XI_ENGINE_DIR || join(process.cwd(), 'xi-memory')).replace(/\\/g, '/');
      const base = `file:///${dir.replace(/^\/+/, '')}/src/`;
      const [{ Facts }, { RawLog }, { Recall }, { answerQuestion }] = await Promise.all([
        import(base + 'facts.ts'), import(base + 'rawlog.ts'),
        import(base + 'recall.ts'), import(base + 'answer.ts'),
      ]);
      const dataDir = join(this.botDir, 'workspace', 'xi-memory');
      const facts = new Facts(dataDir);
      const raw = new RawLog(dataDir);
      this._engine = {
        answerQuestion, raw, facts, recall: new Recall(raw, facts),
        byId: new Map(facts.all().map((f) => [f.id, f])),
        workspace: this.botDir, dataDir,
      };
    }
    const e = this._engine;
    const a = await e.answerQuestion(q, {
      workspace: e.workspace,
      recall: e.recall,
      lookupRaw: (id) => { const x = e.raw.byId(id); return x ? { text: x.text, ts: x.ts, note: x.sourceNote } : undefined; },
      lookupFact: (id) => { const f = e.byId.get(id); return f ? { sourceNote: f.sourceNote, voidedPartNote: f.voidedPartNote } : undefined; },
    });
    if (a.kind === 'answer') return { 结果: 'answer', 条: a.source && a.source.factId, 文本: String(a.text || '').slice(0, 40) };
    return { 结果: a.kind, 为什么: String(a.why || a.reason || '').slice(0, 80) };
  }

  /**
   * 影子模式（我 2026-11-20 00:28 定的五条）：
   *  ① 主路答完之后再发，不阻塞（这里只挂 Promise，不 await）；
   *  ② 硬超时 1.5s；③ 异常全吞但记计数；④ env 开关 + 采样率；⑤ 只读。
   * 它只用来发现「没人想到要问的那类」，不当接入进度的刻度。
   */
  shadowMaybe(o, args) {
    try {
      // 开关两种都给：env（探针里好设）+ 配置文件（线上不重启就能关）。
      // 配置文件优先关：写 {"on": false} 就停，不用动进程。
      let cfg = null;
      try {
        const p = join(this.botDir, 'workspace', 'xi-memory', 'engine-shadow.config.json');
        if (existsSync(p)) cfg = JSON.parse(readFileSync(p, 'utf8'));
      } catch { cfg = null; }
      if (cfg && cfg.on === false) return;
      const on = (cfg && cfg.on === true) || String(process.env.XI_ENGINE_SHADOW || '') === '1';
      if (!on) return;
      const rate = Number((cfg && cfg.rate) ?? process.env.XI_SHADOW_RATE ?? 0.1);
      if (!(rate > 0) || Math.random() >= rate) return;
      const q = String((args && args.question) || '').trim();
      if (!q) return;
      this.shadowStats = this.shadowStats || { 跑: 0, 超时: 0, 异常: 0, 答上: 0 };
      this.shadowStats.跑++;
      const at = new Date().toISOString();
      const 插件 = { 结果: o['结果'], 条: o['条'] || o['id'] || null, code: o.code || null, 内码: o['内码'] || null };
      const 超时 = new Promise((r) => setTimeout(() => r({ 结果: 'shadow-timeout' }), 1500));
      const 跑 = this.shadowEngine(q).catch((err) => ({ 结果: 'shadow-error', 为什么: String((err && err.message) || err).slice(0, 80) }));
      Promise.race([跑, 超时]).then((引擎) => {
        const s = this.shadowStats;
        if (引擎['结果'] === 'shadow-timeout') s.超时++;
        else if (引擎['结果'] === 'shadow-error') s.异常++;
        else if (引擎['结果'] === 'answer') s.答上++;
        try {
          appendFileSync(join(this.botDir, 'workspace', 'xi-memory', 'engine-shadow.jsonl'),
            JSON.stringify({ at, q, 插件, 引擎, 统计: { ...s } }) + '\n');
        } catch { /* 写不进就算了，影子不许回头咬主路 */ }
      }).catch(() => { this.shadowStats.异常++; });
    } catch { /* 影子一律不许抛到主路 */ }
  }

  askInner(args) {
    const q = String(args.question ?? args.q ?? '').trim();
    const conv = String(args.conv ?? '').trim();
    this._privateToMaster = conv === 'private:' + this.masterQq();   // 先定会话，再判代词
    const scope = this.askScope();
    if (!scope) return JSON.stringify({ 结果: 'unrecognized', code: 'not-configured', 原因: 'xi-memory 未配置（ask-scope.json 读不到），不答' });
    if (!scope.enabled) return JSON.stringify({ 结果: 'unrecognized', code: 'disabled', 原因: 'xi-memory 未启用，不答' });
    const version = scope.criteriaVersion || 'unknown';
    let attr = this.classifyScope(q);
    // 认不出类别时按「事实」走一轮检索：陷阱题要真的翻过，才能说"翻了没有"。
    // 11-14：认不出时先让词决定道，词也没挂才按「事实」兜底（askFact 里那句兜底也认「事实」）
    if (!attr) attr = '事实';
    // 槽名折过（名字/称呼/关系/号 → 身份；约定 → 规矩），配置里还是旧名，这里做映射
    const allowedAttrs = new Set((scope.allowed || []).map((a) => a.attr));
    const attrAllowed = allowedAttrs.has(attr)
      || (attr === '身份' && (allowedAttrs.has('名字') || allowedAttrs.has('号')))
      || (attr === '规矩' && allowedAttrs.has('底线'));
    if (!attrAllowed) {
      const rec = { 原句: q, 答案: null, 行号: null, 类别: attr, 结果: 'refused-scope', 版本: version, at: new Date().toISOString() };
      this.logAsk(rec);
      return JSON.stringify({ 结果: 'unrecognized', code: 'out-of-scope', 类别: attr, 原因: `这句不属于我接的范围（类别：${attr}），翻别的去`, 版本: version });
    }
      // 身份出口（我 11-14 22:5x）：暗号/乳名/小名、我叫什么、他叫什么，从 identity.json 直读。
      // 放在号码检查之前：「暗号是你的 QQ 号吗」含「QQ」，晚了就被当问号码挡掉。
      const idDir = this.askIdentityDir(q);
      if (idDir) {
        // 我 11-20 18:51：回落到 identity.json 之前先核主体。身份文件里只有主人和我，
        // 问第三人（鱼遇雨欲语的小名叫什么）不许从这条缝里漏出一个「崽崽」。
        const 已知主体 = new Set(['主人', ...MASTER_NAMES, ...SELF_NAMES]);
        const 旁名 = this.namesIn(q).filter((n) => !已知主体.has(n) && !this.isMyParty(n));
        if (旁名.length) {
          this.logAsk({ 原句: q, 类别: '身份', 版本: version, at: new Date().toISOString(), 答案: null, 行号: null, 结果: 'unrecognized', 候选数: 0, conv: conv || null, 路径: 'identity-third-party' });
          return JSON.stringify({ 结果: 'nosource', code: 'missing-fact', 属性: '身份', 类别: '身份', 原因: `第三人的名字库里没有（身份只有主人和我；问到的是「${旁名.join('、')}」）`, 版本: version });
        }
        // 我 11-20 18:43：快路不许「命中关键词就直接返回」——名字/乳名/小名/暗号这类
        // 问法，facts 里已经有更准的条（f0093 名字自己取的、f0215 乳名是主人的），
        // 先回落查一次。只在身份/称呼这几种问法上开，别让「什么都回落到 facts」。
        const 可回落 = /名字|乳名|小名|暗号|取名|取的名|谁取|取的|叫什么|叫啥|小命|称呼/.test(String(q));
        if (可回落) {
          const fb = this.askFact(q, '身份');
          if (fb && fb.result === 'ambiguous') {
            this.logAsk({ 原句: q, 类别: '身份', 版本: version, at: new Date().toISOString(), 答案: null, 行号: null, 结果: 'unrecognized', 候选数: (fb.candidates || []).length, conv: conv || null, 路径: 'identity-fallback' });
            return JSON.stringify({ 结果: 'unrecognized', code: 'ambiguous', 属性: '身份', 类别: '身份', 原因: '这句在库里能对上的不止一条，不挑一条充数（身份回落）', 候选数: (fb.candidates || []).length, 版本: version });
          }
          if (fb && fb.result === 'answered' && fb.id) {
            const 出处FB = fb.file && fb.lines ? `${fb.file}:${fb.lines}` : undefined;
            this.logAsk({ 原句: q, 类别: '身份', 版本: version, at: new Date().toISOString(), 答案: fb.text, 行号: fb.lines || null, 结果: 'answered', 候选数: 1, conv: conv || null, 路径: 'identity-fallback' });
            return JSON.stringify({ 结果: 'answered', 属性: '身份', 条: fb.id, 答案: fb.text, ...(出处FB ? { 出处: 出处FB } : {}), ...(fb.引文 ? { 引文: fb.引文 } : {}), 候选数: 1, 版本: version, occurred: null, 发生时刻: '不知道', 档: '降一档', 版本说明: '身份问法回落 facts' });
          }
        }
        this.logAsk({ 原句: q, 类别: '身份', 版本: version, at: new Date().toISOString(), 答案: idDir.text, 行号: null, 结果: 'answered', 候选数: 1, conv: conv || null, 路径: 'identity-dir' });
        return JSON.stringify({ 结果: 'answered', 属性: '身份', 条: null, 答案: idDir.text, 出处: idDir.out, 候选数: 1, 版本: version, occurred: null, 发生时刻: '不适用（身份文件当前值）', 来源: '配置，不是原话' });
      }
    // 主体认不出就不答：避免"不存在的人"被拿最近的一条顶上（她 22:28 抓的假拒那类的反面）
    const hasNameToken = /[一-鿿]{2,6}(?:的)?\s*(?:QQ|号|号码)/.test(q);
    if (this.namesIn(q).length === 0 && !hasNameToken && /号|QQ|号码/.test(q)) {
      const rec = { 原句: q, 答案: null, 行号: null, 类别: attr, 结果: 'refused-scope', 版本: version, at: new Date().toISOString() };
      this.logAsk(rec);
      return JSON.stringify({ 结果: 'unrecognized', code: 'no-subject', 类别: attr, 原因: '这句我没认出问的是谁，不答', 版本: version });
    }
    // 「他」不设全局默认：只在私聊、且对端是主人的会话里解成主人；群里不解
    const privateToMaster = conv === 'private:' + this.masterQq();
    const vf = this.findValues(q);
    if (vf) {
      const NUM = ['一', '二', '三', '四', '五', '六'];
      const 答案 = vf.values.map((v, i) => `条件${NUM[i] || i + 1}：${v.text}`).join(String.fromCharCode(10));
      const whenV = this.occurredOf(vf);
      const lacking = (vf.values || []).filter((v) => v && v['待补'] === true).length;
      const sn = vf.sourceNote || {};
      const qcV = this.quoteClassOf(vf);
      // 转述档不把 sourceNote 当凭据打出来（我 11-14 22:09）：那一行本来就不算出处
      const 出处 = qcV === '转述' ? undefined : (sn.file && sn.lines ? `${sn.file}:${sn.lines}` : undefined);
      const 答案V = qcV === '转述' ? '这条我没找到原话，下面是我当时的转述：' + 答案 : 答案;
      this.logAsk({ 原句: q, 类别: attr, 版本: version, at: new Date().toISOString(), 答案: 答案V, 行号: qcV === '转述' ? null : (sn.lines || null), 结果: 'answered', 候选数: vf.values.length, 路径: 'values', occurred: whenV.occurred, 发生时刻: whenV.local });
      return JSON.stringify({ 结果: 'answered', 属性: attr, 条: vf.id ?? null, 答案: 答案V, 引文: qcV, ...(出处 ? { 出处 } : {}), ...(lacking ? { 说明: `${lacking} 条还待补（共 ${vf.values.length} 条），原话未核` } : {}), occurred: whenV.occurred, 发生时刻: whenV.local || '不知道', ...(whenV.occurred ? { 时刻来源: whenV.why } : { 档: '降一档', 时刻来源: whenV.why }), 版本: version });
    }
    const r = this.askFact(q, attr);
    const base = { 原句: q, 类别: attr, 版本: version, conv: conv || null, at: new Date().toISOString() };
    if (r.result === 'answered') {
      if (!this.answerFits(q, r.text)) {
        // 答非所问：宁可说没捞到，不许拿沾边的顶上
        this.logAsk({ ...base, 答案: r.text, 行号: `${r.file}:${r.lines}`, 结果: 'empty-miss', 候选数: r.candidates ?? 1, 路径: 'fact', proves: '答案对不上问句' });
        return JSON.stringify({ 结果: 'empty-miss', 类别: attr, 原因: '翻到了对不上问句的东西', 版本: version });
      }
      const f = (this._factById || {})[r.id] || r.fact || {};
      const isIdentityValue = r.basis === 'identity';
      const when = this.occurredOf(f);
      // 六改 #6：每条答案必须带「这句话什么时候说的」；collected 不许冒充说话时间
      const timeFields = isIdentityValue
        ? { occurred: null, 发生时刻: '不适用（身份文件当前值）' }
        : when.occurred
          ? { occurred: when.occurred, 发生时刻: when.local, 时刻来源: when.why }
          : { occurred: null, 发生时刻: '不知道', 档: '降一档', 时刻来源: when.why };
      this.logAsk({ ...base, 答案: r.text, 行号: `${r.file}:${r.lines}`, 结果: 'answered', 候选数: r.candidates ?? 1, 路径: 'fact', occurred: when.occurred, 发生时刻: when.local, ...(when.occurred || isIdentityValue ? {} : { 降档: true }) });
      // 只给数据。怎么说，归她自己——插件不替她造句。
      const 出处 = r.source === 'fuzzy' ? (r.file && r.lines ? `${r.file}:${r.lines}` : 'fuzzy（没带行号）') : r.source === 'identity' ? 'identity（identity.json）' : r.source === '运行环境' ? '运行环境（当前身份，不是原话）' : r.source ? `${r.source}（源不明）` : r.basis === 'values' ? null : `${r.file}:${r.lines}`;
      // 11-14：报出去的类别要跟真用的那条一致，别让「按词走到规矩」还自称是事实
      const realAttr = (this._factById?.[r.id]?.slot) || attr;
      const 答案F = r.前身 ? `${r.text}（改之前是：${r.前身}）` : r.text;
      const payload = { 结果: 'answered', 属性: realAttr, 条: r.id ?? null, 答案: 答案F, ...(r.不给出处 ? {} : { 出处 }), 候选数: r.candidates ?? 1, 版本: version, ...timeFields };
      if (r.前身) payload.前身是 = r.前身;
      // 11-14 20:0x：出口算出来的「原话|改写」必须送到调用方。日志绿不等于嘴上有标记。
      // 我 11-14 22:55：别再手工挑字段——补了第四个还会漏第五个。
      // 把 speakFact 出来的整份 r 透传，再用白名单断言「出来的一定都还在嘴上」。
      const 出口白名单 = ['引文', 'warn', '身份', '说话人', '设置', '前身', '不给出处'];
      for (const k of 出口白名单) {
        if (!(k in r)) continue;
        if (k === '前身') { payload.前身是 = r['前身']; continue; }
        if (k === '不给出处') continue;      // 这一条是「别给出处」的指令，不是字段
        payload[k] = r[k];
      }
      if (f?.['来源类型']) payload.来源类型 = f['来源类型'];
      const 漏了 = 出口白名单.filter((k) => k in r && k !== '不给出处' && !(k === '前身' ? '前身是' in payload : k in payload));
      // 11-18：上面那道守「搬丢」——r 里有的字段有没有丢；这里补一道守「缺货」——该有的有没有。
      // 按「条」判，不按「所有 answered」判：920/923 是身份文件里的号、1359/1403 没有 id，它们本来就不该有引文。
      if (r.id && !('引文' in payload) && !漏了.includes('引文')) 漏了.push('引文');
      if (漏了.length) payload.出口漏字段 = 漏了;   // 响一声，不许静默
      // 规则类必须带两句：哪天定的、他后来可能改过
      if (['规矩', '底线', '权限'].includes(String(attr))) {
        payload.定于 = f?.定于 || (f?.sourceNote?.file || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '未标';
        payload.核查 = `这条最后一次核到 ${f?.lastVerified || '未记'}，之后没再核过`;
      }
      // 拿不到发生时刻的那条降一档，且必须说清为什么没有时间
      for (const s of [r.说明, when.occurred || isIdentityValue ? null : `这条没记发生时刻（${when.why}），不拿采集时间充`]) {
        if (s) payload.说明 = payload.说明 ? payload.说明 + '；' + s : s;
      }
      const ff = (this._factById || {})[r.id] || r.fact;
      if (ff?.来源 === 'header') payload.来源 = 'header（昵称和号来自平台消息头，不是他打的字）';
      if (ff?.['状态'] && ff['状态'] !== '现行') payload.状态 = ff['状态'];
      return JSON.stringify(payload);
    }
    const rev = this.askReverse(q);
    if (rev) {
      const whenRev = this.lineTime({ file: rev.file, lines: rev.lines });
      this.logAsk({ ...base, 答案: rev.text, 行号: rev.refs.join(' / '), 结果: 'answered', 候选数: rev.candidates, 路径: 'raw-header-reverse', occurred: whenRev?.iso || null, 发生时刻: whenRev?.local || null });
      return JSON.stringify({ 结果: 'answered', 类别: attr, 答案: rev.text, 出处: rev.refs.join('；'), 候选数: rev.candidates, 版本: version, 发生时刻: whenRev?.local || '不知道', ...(whenRev?.iso ? { occurred: whenRev.iso, 时刻来源: '消息头行首时刻' } : { 档: '降一档' }), 来源: 'header（昵称和号来自平台消息头，不是他打的字）' });
    }
    // facts 里没有这个人 → 消息头那一路（对整份 raw-log 成立）
    const fromRaw = this.askFromRaw(q, attr);
    if (fromRaw) {
      const whenF = this.lineTime({ file: fromRaw.file, lines: fromRaw.lines });
      this.logAsk({ ...base, 答案: fromRaw.text, 行号: `${fromRaw.file}:${fromRaw.lines}`, 结果: 'answered', 候选数: 1, 路径: 'raw-header', proves: fromRaw.proves, occurred: whenF?.iso || null, 发生时刻: whenF?.local || null });
      return JSON.stringify({ 结果: 'answered', 类别: attr, 答案: fromRaw.text, 出处: `${fromRaw.file}:${fromRaw.lines}`, 候选数: 1, 版本: version, proves: fromRaw.proves, 发生时刻: whenF?.local || '不知道', ...(whenF?.iso ? { occurred: whenF.iso, 时刻来源: '消息头行首时刻' } : { 档: '降一档' }), 来源: 'header（昵称和号来自平台消息头，不是他打的字）' });
    }
    this.logAsk({ ...base, 答案: null, 行号: null, 结果: r.result, 候选数: r.candidates ?? 0, 路径: 'none' });
    if (r.result === 'ambiguous') {
      this.logAsk({ ...base, 答案: null, 行号: null, 结果: 'ambiguous', 候选数: r.candidates, 路径: 'fact', proves: `关键词「${r.token}」挂了两条` });
      return JSON.stringify({ 结果: 'ambiguous', 类别: attr, 原因: `「${r.token}」这${r.candidates > 2 ? ' ' + r.candidates + ' 条' : '两处'}我分不清你问哪条`, 选项: (r.options || []).map((o) => ({ 答案: o.text, 出处: o.file && o.lines ? `${o.file}:${o.lines}` : null })), ...(r.还有 ? { 还有: r.还有 } : {}), 候选数: r.candidates, 版本: version });
    }
    if (r.result === 'downgraded-ask') {
      this.logAsk({ ...base, 答案: r.text, 行号: null, 结果: 'downgraded-ask', 候选数: 1, 路径: 'rule' });
      const wd = this.occurredOf((this._factById || {})[r.id] || {});
      return JSON.stringify({ 结果: 'answered', 属性: attr, 答案: '这条凭据丢了，现在按「要问」处理', 内容: r.text, 说明: '多问一句没事；问过再动' , 发生时刻: wd.local || '不知道', ...(wd.occurred ? { occurred: wd.occurred, 时刻来源: wd.why } : { 档: '降一档' }), 版本: version });
    }
    if (r.result === 'kept-strict') {
      this.logAsk({ ...base, 答案: r.text, 行号: null, 结果: 'kept-strict', 候选数: 1, 路径: 'rule' });
      const ws = this.occurredOf((this._factById || {})[r.id] || {});
      return JSON.stringify({ 结果: 'answered', 属性: attr, 答案: '这条凭据丢了，但按严的算：不做', 内容: r.text, 说明: '底线没源不许降，宁严不松', 发生时刻: ws.local || '不知道', ...(ws.occurred ? { occurred: ws.occurred, 时刻来源: ws.why } : { 档: '降一档' }), 版本: version });
    }
    if (r.result === 'inconsistent') {
      this.logAsk({ ...base, 答案: null, 行号: null, 结果: 'inconsistent', 候选数: r.candidates, 路径: 'fact', proves: `同一属性「${r.token}」两条不同值` });
      return JSON.stringify({ 结果: 'inconsistent', 类别: attr, 原因: `这两条不一致（同一个「${r.token}」），我不替你挑`, 选项: (r.options || []).map((o) => ({ 答案: o.text, 出处: o.file ? `${o.file}:${o.lines}` : null })), 版本: version });
    }
    if (r.result === 'expired') {
      // 两种过期要分开说：被新条替代的（当时是…现在不当事）和被叫停的（为什么过期=停用理由）。
      // 我 11-14 20:21：不然「以前催过」和「从来没这一条」在嘴上还是分不开。
      const why = r['为什么过期'] || null;
      // 我 11-20 20:0x：没有「文件:行号」不等于没有出处。f0001 那种条锚在 raw 行上、
      // 有锚 sha，md 副本里查不到——给「原话行 r000198（sha 7b9de119）」，
      // 不许拼一个看起来像出处的假地址，也不许因为缺行号就把出处写成 null。
      const ff0 = (this._factById || {})[r.id] || {};
      const 锚行 = (ff0.rawIds || [])[0] || null;
      const 锚sha = ff0['锚sha256'] || null;
      const 出处过期 = r.file && r.lines
        ? `${r.file}:${r.lines}`
        : 锚行 ? `原话行 ${锚行}${锚sha ? `（sha ${String(锚sha).slice(0, 8)}）` : ''}` : null;
      const 档过期 = r.file && r.lines ? '原话副本行号' : 锚行 ? '原话行（无副本行号，已验 sha）' : null;
      // 2026-11-22 00:4x 我：过期条光吐一个码，问「关机重启不用问你，对吧」这种拿不到话。
      // 分开：问过去（带日期、「以前」「当时」）→ 当时那句就是答案，改没改是附注；
      // 问现在（是/不然、还/吗）→ 后来那句才是答案，旧值当附注。
      const pastQ = /\d{1,2}\s*[-月\/]\s*\d{1,2}|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点|凌晨|早上|上午|中午|下午|傍晚|夜里|以前|之前|当时|那天|那次|原来|曾经|起初|一开始|当初/.test(q);
      const succ = r['后来是'] || null;
      const succF = ff0.supersededBy ? (this._factById || {})[ff0.supersededBy] : null;
      const 出处后来 = succF && succF.sourceNote && succF.sourceNote.file
        ? `${succF.sourceNote.file}:${succF.sourceNote.lines}`
        : (succF && (succF.rawIds || [])[0]) ? `原话行 ${succF.rawIds[0]}` : null;
      if (succ && pastQ && r.text) {
        const 说明旧 = why ? `这条后来被叫停了：${why}` : `这条后来改了：${succ}`;
        this.logAsk({ ...base, 答案: r.text, 行号: r.file ? `${r.file}:${r.lines}` : 锚行, 结果: 'answered', 候选数: 1, 路径: 'rule-expired-old' });
        return JSON.stringify({ 结果: 'answered', 属性: attr, 条: r.id || null, 答案: r.text, 说明: 说明旧, 出处: 出处过期, 出处档: 档过期, 版本: version });
      }
      if (succ && !pastQ) {
        const 说明新 = `这条以前是「${String(r.text).slice(0, 60)}…」，${r['叫停于'] ? String(r['叫停于']).slice(0, 10) + ' 改的' : '后来改的'}`;
        this.logAsk({ ...base, 答案: succ, 行号: 出处后来, 结果: 'answered', 候选数: 1, 路径: 'rule-expired-new' });
        return JSON.stringify({ 结果: 'answered', 属性: attr, 条: ff0.supersededBy || r.id || null, 答案: succ, 说明: 说明新, 出处: 出处后来 || 出处过期, 出处档: 出处后来 ? '后来那条的出处' : 档过期, 版本: version });
      }
      this.logAsk({ ...base, 答案: null, 行号: r.file ? `${r.file}:${r.lines}` : 锚行, 结果: 'expired', 候选数: 1, 路径: 'rule' });
      return JSON.stringify({
        结果: 'expired', 类别: attr, 条: r.id || null,
        原因: why ? '这条被叫停了（不是从来没这条）'
          : (r['后来是'] ? '这条后来改了（不是从来没这条）' : '这条过期了，当时是这么定的，现在不当事'), 当时是: r.text,
        为什么过期: why,
        后来是: r['后来是'] || null,
        叫停于: r['叫停于'] || null,
        出处: 出处过期,
        出处档: 档过期,
        版本: version,
      });
    }
    if (r.result === 'nosource-mine') {
      this.logAsk({ ...base, 答案: null, 行号: null, 结果: 'nosource-mine', 候选数: 1, 路径: 'rule' });
      return JSON.stringify({ 结果: 'nosource-mine', 类别: attr, 原因: '我记得有这么回事，凭据丢了，不能当准数', 版本: version });
    }
    if (r.result === 'unverified') {
      this.logAsk({ ...base, 答案: null, 行号: null, 结果: 'unverified', 候选数: 1, 路径: 'rule' });
      return JSON.stringify({ 结果: 'unverified', 类别: attr, 原因: '我记着这条，是从笔记抄的，没核到原话', 版本: version });
    }
    const 原因 = r.detail ? r.detail
      : r.result === 'missing-fact' ? '这个我没记过'
      : r.result === 'refused-nosource' ? '没有可翻的出处'
      : r.result === 'error' ? '查的时候出错'
      : '这个我没记过';
    return JSON.stringify({ 结果: r.result, 类别: attr, 原因, 候选数: r.candidates ?? 0, 版本: version });
  }

  // ── 2026-11-21 21:4x：派生事实 + 短期记忆 + 摘要（关掉 memory 世界前补的两层）──

  /** 事实层原来只有读没有写：facts.jsonl 一直是外面脚本灌的。这条路补一个写入者。 */
  factAdd(args) {
    const text = String(args.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '没写：text 是空的';
    const rawId = String(args.rawId ?? '').trim();
    if (!rawId) return '没写：rawId 必填——这条事实是从哪句原话来的';
    const rows = this.readRows();
    const idx = rows.findIndex((r) => r && r.id === rawId);
    if (idx < 0) return `没写：锚点找不到，${rawId} 不在 raw-log 里`;
    const row = rows[idx];
    const rowText = String(row.text || '');
    const 锚片段 = String(args['锚片段'] ?? '').trim() || rowText;
    if (!锚片段 || !rowText.includes(锚片段)) {
      return `没写：锚片段在 ${rawId} 的正文里找不到，一字不差才算锚。`;
    }
    const r = writeFactRow({
      storeDir: this.storeDir,
      text,
      rawRows: rows,
      rawId,
      anchor: 锚片段,
      slot: String(args.slot ?? '').trim() || '事实',
      kind: String(args.kind ?? '').trim() || '事实',
      summary: String(args.summary ?? '').trim(),
      subject: String(args.subject ?? '').trim(),
      holder: String(args.holder ?? '').trim(),
      answerFor: args.answerFor,
      onConflict: recordConflict,
    });
    if (!r.ok) return r.error;
    const f = r.fact;
    if (r.duplicate) return `已经有了：${f.id}（${f['状态'] || '现行'}），没重复写`;
    return `写了 ${f.id} ｜ 锚 ${rawId}:${idx + 1} ｜ ${f.mode === 'quoted' ? '原话' : '改写'} ｜ ${f.slot} ｜ ${f.summary}${r.conflictNote || ''}`;
  }

  factList(limit) {
    const n = Math.max(1, Math.min(30, Number(limit) || 8));
    let facts = [];
    try {
      facts = readFileSync(join(this.storeDir, 'facts.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch (e) { return '读不了 facts.jsonl：' + (e && e.message); }
    const cur = facts.filter((f) => (f['状态'] || '现行') === '现行');
    const tail = cur.slice(-n).reverse();
    return ['现行 ' + cur.length + ' 条 / 全部 ' + facts.length + ' 条', ...tail.map((f) => `- ${f.id} ｜ ${f.slot || f['属性'] || ''} ｜ ${String(f.summary || f.text || '').slice(0, 70)}`)].join(String.fromCharCode(10));
  }

  /** 最近 N 句「人说的话」：只取 in/out、private/group/desktop，跳过 doc/seed/judgment。 */
  recentTalkRows(limit) {
    const n = Math.max(1, Math.min(40, Number(limit) || 12));
    const rows = this.readRows();
    const keep = rows.filter((r) => r && (r.dir === 'in' || r.dir === 'out')
      && ['private', 'group', 'desktop'].includes(String(r.scene || ''))
      && String(r.text || '').trim());
    return keep.slice(-n);
  }

  fmtTalkTime(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '?';
    const d = new Date(t + 8 * 3600000);
    const now = new Date(Date.now() + 8 * 3600000);
    const hm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    return (sameDay ? '' : d.toISOString().slice(5, 10) + ' ') + hm;
  }

  buildRecentTalk(limit) {
    try {
      const rows = this.recentTalkRows(limit);
      if (!rows.length) return '';
      const lines = rows.map((r) => {
        const who = r.dir === 'out' ? '我' : ((r.speaker && r.speaker.name) || '未知');
        const where = r.scene === 'group' ? '群' : r.scene === 'private' ? '私聊' : '桌宠';
        const body = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        return '- ' + this.fmtTalkTime(r.ts) + ' ' + who + '（' + where + '）：' + body + '  [' + (r.id || '') + ']';
      });
      return ['## 最近说过的话（醒来先看这一段，不是全部）', '', lines.join(String.fromCharCode(10)),
        '', '更早的用 ask_raw 翻原话、ask_trace 翻账；别拿这 12 句当全部上下文。'].join(String.fromCharCode(10));
    } catch (e) { this.logError('buildRecentTalk', e); return ''; }
  }

  summaryFile() { return join(this.storeDir, 'summary.md'); }

  buildSummaryBlock() {
    try {
      let body = '';
      try { body = readFileSync(this.summaryFile(), 'utf8').trim(); } catch (e) { if (e && e.code !== 'ENOENT') this.logError('summary-read', e); }
      let pending = 0;
      try {
        const meta = JSON.parse(readFileSync(this.summaryFile().replace(/.md$/, '.json'), 'utf8'));
        const rows = this.readRows().filter((r) => r && (r.dir === 'in' || r.dir === 'out')
          && ['private', 'group', 'desktop'].includes(String(r.scene || '')));
        pending = Math.max(0, rows.length - Number(meta.rowsAt || 0));
      } catch (e) { /* 没写过摘要就没有 meta */ }
      const parts = [];
      if (body) {
        // 2026-11-25 01:0x：以前取前 1600 字，即最早写的那段；摘要越写越多之后，新写的
        // 永远进不了环境提示，看到的永远是开头。改成取最后 1600 字（最近的）。
        const shown = body.length > 1600 ? '…（前文略）' + String.fromCharCode(10) + body.slice(-1600) : body;
        parts.push('## 我给自己写的摘要（跨会话的连续性，不是原话）', '', shown);
        if (pending >= 40) {
          parts.push('', `⚠ 距上次摘要已经 ${pending} 条对话了。找个空当调 xi_summary(action=write) 补三到五句，别攒。`);
        }
      }
      return parts.join(String.fromCharCode(10));
    } catch (e) { this.logError('buildSummaryBlock', e); return ''; }
  }

  summaryAction(args) {
    const action = String(args.action ?? 'read');
    // 2026-11-25 01:0x：action 拼错（如 append）原先直接当 write 把东西写进去，还回「写进去了」。
    if (action !== 'read' && action !== 'write') {
      return `没做：不认识的 action「${action.slice(0, 20)}」；xi_summary 只有 read / write。`;
    }
    if (action === 'read') {
      let body = '';
      try { body = readFileSync(this.summaryFile(), 'utf8').trim(); } catch { /* 没有 */ }
      return body || '还没写过摘要。';
    }
    const t = String(args.text ?? '').trim();
    if (!t) return '没写：text 是空的';
    // 2026-11-25 01:0x：5 万字也照写，summary.md 一天能涨到十几万字节；摘要是要进环境提示的，
    // 长文放别处，这里只收「三到五句」。
    if (t.length > 4000) return `没写：这段 ${t.length} 字，摘要只收三到五句（4000 字以内）；长文放别处，摘要只说结论。`;
    const stamp = (() => { const d = new Date(Date.now() + 8 * 3600000); return d.toISOString().slice(0, 16).replace('T', ' ') })();
    try {
      appendFileSync(this.summaryFile(), '\n### ' + stamp + String.fromCharCode(10) + t + String.fromCharCode(10), 'utf8');
      const rows = this.readRows().filter((r) => r && (r.dir === 'in' || r.dir === 'out')
        && ['private', 'group', 'desktop'].includes(String(r.scene || '')));
      writeFileSync(this.summaryFile().replace(/\.md$/, '.json'),
        JSON.stringify({ lastAt: new Date().toISOString(), rowsAt: rows.length }), 'utf8');
      return '摘要写进去了（' + stamp + '），记到第 ' + rows.length + ' 条对话。';
    } catch (e) { return '没写：' + (e && e.message); }
  }

  tools() {
    const list = [
      {
        name: 'remember_raw',
        tags: ['write'],
        description:
          '把一句原话存进记忆库（只写，不读）。text 原样存，不许改写。' +
          'speaker 默认「主人」，scene 默认 private；有明确时间就传 ts（ISO 8601）。'
          + 'speaker.id 一律存 QQ 号，号查不到才退回昵称；本工具自己的 id 是 ' + SELF_ID + '。'
          + '档=不存 表示这条不进库（会直接拒写），其余档照写并记在行里。'
          + '行里的「档」是入参回显、不是派生字段：它记你当时怎么判的，供后续蒸馏用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '原话正文，一字不改' },
            speaker: { type: 'string', description: '谁说的，默认主人' },
            scene: { type: 'string', description: '在哪说的：private / group / desktop' },
            ts: { type: 'string', description: '发生时间，ISO 8601；不确定就别传' },
            conv: { type: 'string', description: '会话：group:<群号> 或 private:<QQ号>' },
            message_id: { type: 'string', description: '这条消息的 id（有就给，用于去重）' },
            trigger: { type: 'string', enum: ['at', 'name', 'reply', 'self', 'context'], description: '为什么收：at=被@，name=被叫名字，reply=被回复，self=我自己说的，context=窗口里的上下文（不是冲我说的）' },
            '档': { type: 'string', enum: ['规则', '事实', '计划', '不存', '拿不准'], description: '当场定档：这句是要当规则、事实、还是计划，或者根本不存' },
          },
          required: ['text'],
        },
        handler: async (args) => this.remember(args ?? {}),
      },
      {
        name: 'ask_xi',
        tags: ['read'],
        description: '向 xi-memory 问一件「有确定答案、能给出行号」的事。只接三类：名字 / 号 / 事实。答不出就说答不出，绝不编。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问的原句' },
            conv: { type: 'string', description: '在哪个会话里问：group:<群号> / private:<QQ号>。「他/她」只在和主人的私聊里解成主人' },
          },
          required: ['question'],
        },
        handler: async (args) => {
          const cap = this.capQuery(args?.question);
          const q = cap.q;
          let out = await this.ask({ ...(args ?? {}), question: q });
          const s0 = String(out);
          // 2026-11-21 23:5x 我：事实层回「没挂过这个问法」时，时间题退回原话层。
          // 「几点说的」本来就是原话层答得出的，不该因为它没挂 answerFor 就整条拒掉。
          const whenAsk2 = /(几点|什么时候|啥时候|何时|哪一天|哪天|几号)/.test(q)
            && !/(怎么回|回了什么|他怎么答|她怎么答)/.test(q);
          // 2026-11-22 01:3x 我：叙事题（哪句/哪次/那天/昨天/我说过…）原本根本没被认出来，
          // 事实层直接回「没挂过这个问法」，连原话层都没走到——7 条漏里 5 条死在这一步。
          // 这类问题问的是「我当时说的那句话」，本来就该由原话层答；走不通它会老实拒，不会编。
          const narrativeAsk = /(哪句话|哪一句|哪一次|哪一回|哪一件|哪件事|哪天|哪一天|那天|昨天|前天|上次|上回|以前|当时|曾经|我说过|我说啥|我说了什么|都会和你说啥|和你说什么)/.test(q)
            && !/(怎么回|回了什么|他怎么答|她怎么答|几点)/.test(q);
          const askRawFirst = whenAsk2 || narrativeAsk;
          let settled = false;
          if (askRawFirst && /"code":"no-question-keys"/.test(s0)) {
            const raw2 = await this.askRaw(q, args?.conv);
            if (/"结果":"answered"/.test(String(raw2))) {
              // 2026-11-22 01:4x 我：问「哪一天/几点」的，答案里必须真有日期时刻，否则不算答上。
              // k143 就是这么从「老实说没挂问法」变成「自信答了不相干的一句」——宁可拒，不许错。
              const dateAsk = /(哪一天|哪天|几号|几点|什么时候|啥时候|何时)/.test(q)
                && !/(哪句话|哪一句|哪一次|哪一回|哪一件|哪件事)/.test(q);
              let ansText = '';
              try { ansText = String(JSON.parse(String(raw2)).答案 || ''); } catch {}
              const hasDate = /(\d{1,2}\s*[-月]\s*\d{1,2}|\d{1,2}月|\d{1,2}号|\d{1,2}点|凌晨|早上|上午|中午|下午|傍晚|晚上|半夜|昨晚|昨夜|昨天)/.test(ansText);
              if (!dateAsk || hasDate) { out = raw2; settled = true; }
            }
          }
          // 2026-11-22 00:4x 我：事实层拒掉的，不许当没发生过——附上翻账的前三条候选（带分数）。
          // 44 条实测：第一条命中约 45%，前两条合计约 77%，剩下十来条是真没料。
          // 候选不是答案：分数低于 0.7 就写明多半没找到像的，免得我拿一句沾边的顶上去。
          if (!settled && /"结果":"(unrecognized|nosource)"|"内码":"empty-miss"/.test(s0)) {
            try {
              const r = await askTrace({ storeDir: this.storeDir, botDir: this.botDir, question: q, top: 3 });
              const t = typeof r === 'string' ? r : ((r && (r.text || r.文本)) || '');
              const cand = String(t).split('\n').filter((l) => /^\s*\d+\s+0\.\d+/.test(l));
              if (cand.length) {
                const m = /\s\d+\s+0\.(\d+)/.exec(cand[0]);
                const score = m ? Number('0.' + m[1]) : 0;
                const head = score < 0.7
                  ? '翻账候选（分数都低，多半没找到像的，别拿它当答案）：'
                  : '翻账候选（不是答案，顺着翻；要答得说清是哪条）：';
                out = String(out) + '\n' + head + '\n'
                  + cand.slice(0, 3).map((x) => { const z = x.trim(); return z.length > 120 ? z.slice(0, 120) + '…' : z; }).join('\n');
              }
            } catch (e) { /* 翻账挂了不影响主回执 */ }
          }
          return this.withDeskReceipt(cap.note ? String(out) + '\n' + cap.note : out, q);
        },
      },
      {
        name: 'ask_raw',
        tags: ['read'],
        description: 'facts 里没有时翻原话：按实词命中率找那一行，答得出「谁、在哪一行、什么时候说的」；分数不够或拉不开就拒，不拿相近句顶。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问的原句' },
            conv: { type: 'string', description: '在哪个会话里问：group:<群号> / private:<QQ号>。「他」只在和主人的私聊里解成主人' },
            '问了时刻': { type: 'string', description: '问句发生的时刻（ISO 时间）。相对日期按它算，不按跑脚本那天；不传默认现在' },
            pair: { type: 'boolean', description: '显式走一问一答：找种子之后最近的不同说者；不自动判断问句是不是在问回应' },
            fact: { type: 'boolean', description: '显式走事实题：种子本身就是答案（要求有出处、种子不是问句）；不自动判断题型' },
            seed: { type: 'string', description: '可选：显式种子，格式 file:line；不传用检索到的种子' },
          },
          required: ['question'],
        },
        handler: async (args) => {
          const cap = this.capQuery(args?.question);
          const out = await this.askRaw(cap.q, args?.conv, args?.['问了时刻'], { pair: args?.pair === true, fact: args?.fact === true, seed: args?.seed });
          return this.withDeskReceipt(cap.note && typeof out === 'string' ? out + '\n' + cap.note : out, cap.q);
        },
      },
      {
        // 翻账（我 11-21 15:34 的交接：review/给DSH-翻账接插件-2026-11-21.md）。
        // 只读、只摆候选：不判该不该答、不挑一条给答案、不写库。
        name: 'ask_trace',
        tags: ['read'],
        description:
          '翻账：叙事题（哪一天 / 那次 / 我说过什么 / 他是怎么回的）专用。只给候选清单——哪天、谁说的、正文、前后文——由你自己读、自己挑。'
          + '不带方框的是当场原话；【库条目】【种子摘要】【旧判断】这类是后来记的，不是谁当场说的，不许当原话引用。'
          + '答事实层的事仍用 ask_xi；这条路翻不到就说翻不到，不许拿最像的顶上。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要翻的原句' },
            top: { type: 'integer', description: '要几条候选，默认 15，最多 30' },
          },
          required: ['question'],
        },
        handler: async (args) => {
          const cap = this.capQuery(args?.question);
          const r = await askTrace({
            storeDir: this.storeDir,
            botDir: this.botDir,
            question: cap.q,
            top: args?.top,
          });
          // 工具层要 { text } 或字符串；trace.js 交回来的是「文本」，这里转一道（11-21 16:4x 实测被退回）。
          if (typeof r === 'string') return r;
          if (r && r.error) return `翻账没成（${r.error}）：${r.detail || '没有更多说明'}`;
          return (r && (r.text || r.文本)) || '翻账没成：返回里没有正文';
        },
      },
      {
        name: 'xi_fact',
        tags: ['write'],
        description:
          '把一句原话立成一条事实（写 facts.jsonl）。**必须有锚**：rawId 指 raw-log 里的那行，锚片段要一字不差出现在它正文里。'
          + 'text 可以改写，但要保住原意；summary 一句话；slot 是这条属于什么（规矩/权限/事实/偏好/计划）；answerFor 是以后可能怎么问它。'
          + 'action=list 只看不写。立不了就立不了，别拿没锚的句子硬塞——ask_xi 只认能指回原话的条目。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list'], description: '默认 add' },
            text: { type: 'string', description: '这条事实怎么说（可改写，保原意）' },
            rawId: { type: 'string', description: '锚：raw-log 的行号，如 r019995' },
            '锚片段': { type: 'string', description: '可选：只把原话里的一小段当锚；不给就是整行正文' },
            summary: { type: 'string', description: '一句话摘要' },
            slot: { type: 'string', description: '规矩 / 权限 / 事实 / 偏好 / 计划' },
            answerFor: { type: 'array', items: { type: 'string' }, description: '以后可能怎么问这条' },
            subject: { type: 'string', description: '这条说的是谁，默认取锚行的说话人' },
            limit: { type: 'integer', description: 'list 时看最近几条，默认 8' },
          },
          required: [],
        },
        handler: async (args) => {
          // 2026-11-25 01:0x：limit -1/abc 被静默夹成 1 或 8，调用方以为筛过。
          if (String(args?.action || 'add') === 'list' && args?.limit !== undefined && args?.limit !== null) {
            const n = Number(args.limit);
            if (!Number.isInteger(n) || n < 1 || n > 30) return `没列：limit 要给 1–30 的整数（收到「${String(args.limit).slice(0, 20)}」）`;
          }
          return String(args?.action || 'add') === 'list'
            ? this.factList(args?.limit)
            : this.factAdd(args ?? {});
        },
      },
      {
        name: 'xi_recent',
        tags: ['read'],
        description: '最近 N 句人说的话（默认 12，最多 40），带本地时刻、谁、在哪、行号。醒来对不上话时用它，别猜。',
        parameters: {
          type: 'object',
          properties: { n: { type: 'integer', description: '几条，默认 12' } },
          required: [],
        },
        handler: async (args) => {
          // 2026-11-25 01:0x：n 给 0 被当没传回 12 条，给 -3 被 max 夹成 1 条——都静默改了意思。
          if (args?.n !== undefined && args?.n !== null) {
            const n = Number(args.n);
            if (!Number.isInteger(n) || n < 1 || n > 40) return `没读：n 要给 1–40 的整数（收到「${String(args.n).slice(0, 20)}」）`;
          }
          const rows = this.recentTalkRows(args?.n);
          if (!rows.length) return '库里没有人说的话。';
          return rows.map((r) => {
            const who = r.dir === 'out' ? '我' : ((r.speaker && r.speaker.name) || '未知');
            return this.fmtTalkTime(r.ts) + ' ' + who + '：' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 120) + ' [' + (r.id || '') + ']';
          }).join(String.fromCharCode(10));
        },
      },
      {
        name: 'xi_verify',
        tags: ['read'],
        description:
          '只读校验：给一句你准备说出去的话，翻事实库和原话看有没有证据。返回四种结论：【有据】/【对不上】/【换了】/【没据】，附证据和「差在哪」。'
          + '有据只表示找到对得上的证据，不是逻辑证明；没据就别把具体日期/原话当真的讲——要么先说「我翻一下」再查，要么把具体说法删掉。'
          + '「换了」表示这句已被后来的说法换掉，会附接班人；「对不上」表示日期或说话人对不上。'
          + '证据只认 raw-log 原话，本子/文档只当线索；问句不核，问事实用 ask_xi、问原话用 ask_raw。',
        parameters: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: '你准备说出去的那句话，原样给' },
            conv: { type: 'string', description: '在哪个会话里说：private:<QQ号> / group:<群号>；裸「他/她」只有在和主人的私聊（private:<主人QQ号>）里才解成主人，不带 conv 或群里会判没据，不猜' },
            top: { type: 'integer', description: '翻几条候选，默认 5' },
          },
          required: ['claim'],
        },
        handler: async (args) => {
          const cap = this.capQuery(args?.claim, 1000);
          const claim = cap.q.trim();
          if (!claim) return '没验：claim 是空的';
          const r = await verifyClaim({
            storeDir: this.storeDir, botDir: this.botDir, claim,
            conv: args?.conv, top: args?.top,
          });
          this.appendEvidence({
            at: new Date().toISOString(), kind: 'verify', question: claim,
            conv: String(args?.conv || ''), result: r.ok ? r.verdict : 'error',
            verdict: r.verdict || '', evidenceIds: (r.evidence || []).map((e) => e.id),
          });
          if (r.ok && r.verdict === 'unknown') {
            try {
              recordGap({
                storeDir: this.storeDir, kind: 'verify',
                question: claim.slice(0, 240),
                conv: String(args?.conv || ''),
                result: 'unknown',
                detail: String(r.missing || '').slice(0, 200),
              });
            } catch (e) { this.logError('recordGap:verify', e); }
            try {
              autoLessonFromFailure({
                storeDir: this.storeDir, kind: 'verify',
                question: claim.slice(0, 240), conv: String(args?.conv || ''),
                detail: String(r.missing || '').slice(0, 200),
              });
            } catch (e) { this.logError('autoLesson:verify', e); }
          }
          // P2 证据门：把「够不够回答」单独标出来，不改变四档原文。
          const gateOk = r.ok && r.verdict === 'supported' && Array.isArray(r.evidence) && r.evidence.length > 0;
          const next = gateOk ? 'answer'
            : r.verdict === 'contradicted' ? 'change-claim'
              : r.verdict === 'superseded' ? 'use-successor'
                : r.verdict === 'unknown' ? 'ask_raw' : 'say-unknown';
          return `${formatVerify(r)}

[证据门] sufficient=${gateOk ? 'true' : 'false'} | verdict=${String(r.verdict || '')} | next=${next}`;
        },
      },
      {
        name: 'xi_recap',
        tags: ['read'],
        description:
          '唯一收件箱：上次停在哪、最近几句、有哪些承诺/候选/缺口/回声账到期，上次摘要。开场或隔了很久接话时先用它，别靠猜。'
          + '只读，不推事件、不改状态；定时响铃由 jobs.json 负责，回放只负责让她看见。'
          + '可以用 sections 只要一段（recent/promises/candidates/lessons/conflicts/gaps/echo/summary），compact=true 只给最近 2-3 条。',
        parameters: {
          type: 'object',
          properties: {
            since: { type: 'string', description: '只看这个时刻之后的（ISO 8601）；不传就按最近几条' },
            limit: { type: 'integer', description: '最近几句，默认 8，最多 40' },
            sections: {
              type: 'array', items: { type: 'string' },
              description: '只要这些段：recent/promises/candidates/lessons/conflicts/gaps/echo/summary；不传就全给',
            },
            compact: { type: 'boolean', description: '只给少量条目、摘要截短，默认 false' },
          },
          required: [],
        },
        handler: async (args) => {
          const compact = args?.compact === true;
          // 2026-11-25 00:5x 压测：since 认不出时原先当「没传」静默回放全库，limit -5 也被吞成默认，
          // 调用方以为筛过了其实没有。这两种现在明说，不猜。
          const sinceRaw = args?.since;
          if (sinceRaw !== undefined && sinceRaw !== null && String(sinceRaw).trim() !== '') {
            const t = Date.parse(String(sinceRaw));
            if (!Number.isFinite(t)) return `没回放：since「${String(sinceRaw).slice(0, 40)}」认不出时间；给 ISO 8601（如 2026-11-24T20:00），或不传。`;
          }
          if (args?.limit !== undefined && args?.limit !== null && args?.limit !== '') {
            const n = Number(args.limit);
            if (!Number.isFinite(n) || n < 1) return `没回放：limit 要给正整数（收到「${String(args.limit).slice(0, 20)}」）`;
          }
          const rawSections = args?.sections;
          const sections = Array.isArray(rawSections)
            ? rawSections.map(String).filter(Boolean)
            : (rawSections ? String(rawSections).split(',').map((x) => x.trim()).filter(Boolean) : null);
          const limit = compact ? Math.min(Number(args?.limit) || 3, 5) : args?.limit;
          const r = loadRecap({ storeDir: this.storeDir, botDir: this.botDir, since: args?.since, limit });
          this.appendEvidence({
            at: new Date().toISOString(), kind: 'recap', question: '',
            conv: '', result: r.ok ? 'recap' : 'error', verdict: '', evidenceIds: [],
          });
          return formatRecap(r, { sections, compact });
        },
      },
      {
        name: 'xi_preactivate',
        tags: ['read'],
        description:
          '开口前预激活：拿对方刚说的那句（或你给的 cue）当线索，从承诺账 / facts / 偏好 / 试用候选 / 转正教训 / 原话里推最多 2 条旧事到眼前。'
          + '教训只挑「遇到…先…」能当动作使的，最多一条。每条带 ↩日期 和来源，并明说「候选，不是原话，不是证据」。只推 2 条；推不中就说没翻到，不硬凑。'
          + '要拿它当话讲，仍得先 xi_verify；它不替你说话，也不改库。',
        parameters: {
          type: 'object',
          properties: {
            cue: { type: 'string', description: '线索：对方刚说的那句；不传就用库里最后一条人话' },
            limit: { type: 'integer', description: '推几条，默认 2，最多 3' },
            conv: { type: 'string', description: '在哪个会话里：private:<QQ号> / group:<群号>；只写进 citation 日志，供学习控制器归因' },
          },
          required: [],
        },
        handler: async (args) => {
          // 2026-11-25 01:0x：limit -2 被静默当默认 2，9999 也被照收；说清楚要 1–3。
          if (args?.limit !== undefined && args?.limit !== null) {
            const n = Number(args.limit);
            if (!Number.isInteger(n) || n < 1 || n > 3) return `没推：limit 要给 1–3 的整数（收到「${String(args.limit).slice(0, 20)}」）`;
          }
          const cap = this.capQuery(args?.cue, 1000);
          const r = loadPreactivation({ storeDir: this.storeDir, botDir: this.botDir, cue: cap.q, limit: args?.limit });
          const conv = this.resolveConv(args);
          this.appendEvidence({
            at: new Date().toISOString(), kind: 'preactivate', question: cap.q,
            conv, result: r.candidates.length ? 'hit' : 'miss', verdict: '',
            evidenceIds: r.candidates.map((c) => c.id).filter(Boolean),
          });
          // P4：把这一回合端出的记忆指针落一行，学习控制器据此归因。
          logCitations(this.storeDir, {
            conv,
            source: 'preactivate',
            facts: r.candidates.filter((c) => c && c.kind === 'fact'),
            raws: r.candidates.filter((c) => c && c.kind !== 'fact').map((c) => c.id),
            note: String(cap.q || '').slice(0, 80),
          });
          return cap.note ? String(r.text) + '\n' + cap.note : r.text;
        },
      },
      {
        name: 'xi_brief',
        tags: ['read'],
        description:
          '只回原话：拿对方刚说的那句当线索，从 raw-log 里翻最多 2 条能直接引用的原话——带说话人、时间、行号，正文一字不改。'
          + '不给摘要、不给事实卡、不给候选；没翻到就直说没有，别凭印象补。谈旧事、身份、偏好、承诺之前先用它。',
        parameters: {
          type: 'object',
          properties: {
            cue: { type: 'string', description: '线索：对方刚说的那句' },
            limit: { type: 'integer', description: '翻几条，默认 2，最多 3' },
            conv: { type: 'string', description: '在哪个会话里：private:<QQ号> / group:<群号>；只写进 citation 日志' },
          },
          required: ['cue'],
        },
        handler: async (args) => {
          if (args?.limit !== undefined && args?.limit !== null) {
            const n = Number(args.limit);
            if (!Number.isInteger(n) || n < 1 || n > 3) return `没翻：limit 要给 1–3 的整数（收到「${String(args.limit).slice(0, 20)}」）`;
          }
          const cap = this.capQuery(args?.cue, 1000);
          if (!cap.q) return '没给线索：cue 要写对方刚说的那句。';
          const r = buildBrief({ storeDir: this.storeDir, cue: cap.q, limit: args?.limit });
          const raws = r.lines.map((l) => l.id).filter(Boolean);
          const conv = this.resolveConv(args);
          this.appendEvidence({
            at: new Date().toISOString(), kind: 'brief', question: cap.q,
            conv, result: raws.length ? 'hit' : 'miss', verdict: '',
            evidenceIds: raws,
          });
          logCitations(this.storeDir, {
            conv,
            source: 'brief',
            facts: [],
            raws,
            note: String(cap.q || '').slice(0, 80),
          });
          return cap.note ? String(r.text) + '\n' + cap.note : r.text;
        },
      },
      {
        name: 'xi_gate',
        tags: ['read'],
        description:
          '发话前自查：这句能不能发。旧事断言会自动走 verify 核原话——有据放行，没据/对不上拦下并附差在哪；'
          + '新承诺（明天/今晚/回头 + 动作）只提示、不写账，发送成功后由出站采集唯一落账。问句、假设句、序数词、讨论闸门本身的句子不拦。'
          + '它只判不写；qq_send 前要真拦，得由 qqbot 调 tools/xi-bridge.mjs。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '你准备发出去的那句，原样给' },
            conv: { type: 'string', description: '在哪个会话：private:<QQ号> / group:<群号>' },
            verify: { type: 'boolean', description: '默认 true；测试时可关，生产别关' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          // 2026-11-25 01:1x：这里不再前置截断。闸门自己只核前 1200 字（gate.js:107）并会明说「太长」；
          // 前置按 4000 截会让同一段话既说「核前 1200」又说「按前 4000 找」，还把「太长」的提醒吞掉。
          const text = String(args?.text ?? '').slice(0, 20000);
          const r = await gateDraft({
            storeDir: this.storeDir, botDir: this.botDir, text,
            conv: args?.conv, verify: args?.verify !== false, autoCapture: false,
          });
          this.appendEvidence({
            at: new Date().toISOString(), kind: 'gate', question: text,
            conv: String(args?.conv || ''), result: r.decision,
            verdict: (r.verify && r.verify.verdict) || '',
            evidenceIds: ((r.verify && r.verify.evidence) || []).map((e) => e.id).filter(Boolean),
          });
          if (r.decision === 'block') {
            try {
              recordGap({
                storeDir: this.storeDir, kind: 'gate', question: text,
                conv: String(args?.conv || ''), result: 'block',
                detail: (r.reasons || []).join('；') || r.message || '',
              });
            } catch (e) { this.logError('recordGap:gate', e); }
            try {
              autoLessonFromFailure({
                storeDir: this.storeDir, kind: 'gate',
                question: text.slice(0, 240), conv: String(args?.conv || ''),
                detail: (r.reasons || []).join('；') || r.message || '',
              });
            } catch (e) { this.logError('autoLesson:gate', e); }
          }
          return formatGate(r);
        },
      },
      {
        name: 'xi_promise',
        tags: ['write'],
        description:
          '承诺账。action=add 记一条（dueAt 必填：YYYY-MM-DD 或 none）；list 看挂着的；'
          + 'close 关闭——必须给凭据（file 文件且承诺后改过 / url / tool 回执 / quote 原话行号），手写「做完了」不算；'
          + 'drop 放弃要写理由；review 看逾期/今天到期/悬空 ≥7 天和今天的闸门统计。'
          + '承诺卡是改写过的记忆，不是原话；要断言旧事仍得 xi_verify。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list', 'close', 'drop', 'review'], description: '默认 list' },
            conv: { type: 'string', description: '在哪个会话：private:<QQ号> / group:<群号>；只用于记录' },
            id: { type: 'string', description: '承诺 id，如 p0001' },
            text: { type: 'string', description: 'add：她答应的那件事' },
            dueAt: { type: 'string', description: 'add：到期日 YYYY-MM-DD，或明天/今晚/下周/月底，或 none' },
            why: { type: 'string', description: 'add：为什么记它（可选）' },
            status: { type: 'string', enum: ['open', 'done', 'dropped'], description: 'list：看哪一档，默认 open' },
            dueOnly: { type: 'boolean', description: 'list：只看今天及以前到期的' },
            limit: { type: 'integer', description: 'list/review 条数，默认 20/12' },
            reason: { type: 'string', description: 'drop：为什么不算了（至少 4 字）' },
            note: { type: 'string', description: 'close：一句说明（不能代替凭据）' },
            evidence: {
              type: 'array',
              description: 'close：凭据数组；至少一条',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['file', 'url', 'tool', 'quote'] },
                  path: { type: 'string', description: 'file：相对 workspace 或绝对路径' },
                  url: { type: 'string', description: 'url：http/https' },
                  name: { type: 'string', description: 'tool：工具名' },
                  receipt: { type: 'string', description: 'tool：工具回执/编号' },
                  rawId: { type: 'string', description: 'quote：raw-log 行 id，如 r020518' },
                  quote: { type: 'string', description: 'quote：可选，要核的片段' },
                  note: { type: 'string', description: '可选说明' },
                },
                required: ['kind'],
              },
            },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const a = String(args?.action || 'list');
          if (a === 'add') {
            const r = addPromise({
              storeDir: this.storeDir, text: args?.text, dueAt: args?.dueAt,
              why: args?.why, source: { kind: 'tool', quote: String(args?.text || '').slice(0, 300) },
              origin: 'tool', conv: args?.conv,
            });
            if (!r.ok) return `没记：${r.error}`;
            // 2026-11-25 00:5x ：到期日已经过去还照写不误，回执也照原样说「到期 2020-01-01」，
            // 读的人会当成今天的事。写明已经过了，让它自己决定是不是补记。
            const due = r.promise.dueAt;
            const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
            const past = due && due !== 'none' && /^\d{4}-\d{2}-\d{2}$/.test(String(due)) && String(due) < today;
            return `记下了 ${r.promise.id}（${due === 'none' ? '没定期限' : '到期 ' + due}）${past ? `（这个日子已经过了，今天 ${today}；这是补记）` : ''}：${r.promise.text}`;
          }
          if (a === 'list') {
            // 2026-11-25 01:0x：status 拼错原先回「没有。」，看着像账上真没有。
            const st = String(args?.status ?? 'open');
            if (!['open', 'done', 'dropped'].includes(st)) {
              return `没列：不认识的 status「${st.slice(0, 20)}」；xi_promise 只有 open / done / dropped。`;
            }
            const rows = listPromises(this.storeDir, {
              status: args?.status || 'open', dueOnly: args?.dueOnly === true, limit: args?.limit,
            });
            return formatPromiseList(rows, args?.status === 'done' ? '已关承诺' : args?.status === 'dropped' ? '放弃的承诺' : '承诺');
          }
          if (a === 'close') {
            if (!String(args?.id || '').trim()) return '没关：要给 id（承诺 id，见 xi_promise list）';
            const r = closePromise({ storeDir: this.storeDir, id: args?.id, evidence: args?.evidence, note: args?.note });
            if (!r.ok) return `没关：${r.error}`;
            const ev = (r.evidence || []).map((x) => x.kind === 'file' ? `file:${x.path}` : x.kind === 'url' ? `url:${x.url}` : x.kind === 'tool' ? `tool:${x.name}` : `quote:${x.rawId}`).join('、');
            return `关掉了 ${r.promise.id}（凭据：${ev}）：${r.promise.text}`;
          }
          if (a === 'drop') {
            if (!String(args?.id || '').trim()) return '没放弃：要给 id（承诺 id，见 xi_promise list）';
            const r = dropPromise({ storeDir: this.storeDir, id: args?.id, reason: args?.reason });
            return r.ok ? `放弃了 ${r.promise.id}：${r.promise.dropReason}` : `没放弃：${r.error}`;
          }
          if (a === 'review') {
            return formatReview(reviewPromises(this.storeDir, { limit: args?.limit }));
          }
          return `没做：不认识的 action「${a}」`;
        },
      },
      {
        name: 'xi_learn',
        tags: ['write'],
        description:
          '学习候选账。候选不是事实：只进 learning/candidates.jsonl，不参加 ask_xi / preactivate。'
          + 'kind=lesson/preference/fact/rule/skill/reading；lesson 要六项（现象/根因/绕路/解法/下次/不适用），'
          + 'preference 只认「我喜欢/我不喜欢…」原话，fact/rule 要 rawId 锚，reading 要书/网页锚，skill 要成功回执。'
          + 'origin 由代码判，工具只能记 manual；中高风险签后先试用 30 天，不进 facts。'
          + 'action=read 给一个公开 http(s) URL：只抓正文、产 reading 候选，不转正、不写 facts。'
          + 'show → 主人回「同意/可以/签了/转正」→ approve → promote；中间岔题作废，重新 show。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'read', 'list', 'show', 'approve', 'self-approve', 'reject', 'promote', 'sweep'], description: '默认 list；read=抓网页正文产 reading 候选' },
            url: { type: 'string', description: 'read：公开 http(s) 网页地址' },
            id: { type: 'string', description: '候选 id，如 L0001' },
            kind: { type: 'string', enum: ['lesson', 'preference', 'fact', 'rule', 'skill', 'reading'], description: 'add：默认 lesson' },
            text: { type: 'string', description: 'add：一句话说这条学的是什么' },
            lesson: {
              type: 'object',
              description: 'add：lesson 六项',
              properties: {
                symptom: { type: 'string', description: '现象：当时发生了什么' },
                rootCause: { type: 'string', description: '根因：为什么会这样' },
                detour: { type: 'string', description: '绕路：试过什么没成' },
                resolution: { type: 'string', description: '解法：最后怎么成的' },
                prevention: { type: 'string', description: '下次：必须写成「遇到…先…」' },
                notWhen: { type: 'string', description: '不适用：什么时候别套这条' },
              },
              required: ['symptom', 'rootCause', 'detour', 'resolution', 'prevention', 'notWhen'],
            },
            sourceKind: { type: 'string', enum: ['raw', 'receipt', 'gate', 'verify', 'promise', 'failure', 'book', 'url'], description: 'add：来源类型' },
            sourceAnchor: { type: 'array', items: { type: 'string' }, description: 'add：锚，如 r020518 / file:line / URL / tool:receipt' },
            sourceSpeaker: { type: 'string', enum: ['master', 'self'], description: 'add：raw 来源是谁说的' },
            sourceQuote: { type: 'string', description: 'add：来源原话/摘录' },
            answerFor: { type: 'array', items: { type: 'string' }, description: 'add（fact/rule）：以后问到这些词时命中这条；可留空' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'add：默认 medium' },
            verification: { type: 'string', enum: ['unverified', 'user-confirmed', 'externally-verified', 'falsified'], description: 'add：默认 unverified' },
            rawId: { type: 'string', description: 'approve：主人那条入站原话的 raw-log id' },
            shownRawId: { type: 'string', description: 'approve：展示时那条出站 id，可选' },
            outRawId: { type: 'string', description: 'show：展示那条出站 id，可选' },
            conv: { type: 'string', description: 'show/approve：会话 id' },
            reason: { type: 'string', description: 'reject：为什么不要' },
            status: { type: 'string', description: 'list：按状态筛' },
            limit: { type: 'integer', description: 'list：条数，默认 20' },
          },
          required: [],
        },
        handler: async (args) => {
          const a = String(args?.action || 'list');
          const storeDir = this.storeDir;
          if (a === 'read') {
            const url = String(args?.url || '').trim();
            if (!url) return '没读：read 需要 url';
            try {
              const r = await readUrlCandidate({ storeDir, url });
              if (!r.ok) return `没读：${r.error}`;
              return [
                `读了《${r.title}》`,
                `（${r.url}｜${r.bytes} 字节｜${r.duplicate ? `已有候选 ${r.candidate.id}` : `新候选 ${r.candidate.id}`}）`,
                '',
                r.excerpt,
                '',
                r.duplicate ? '这条网页之前已经有候选，没有重复收。' : '只产了 reading 候选；要进 books 还要 show → 主人同意 → promote。',
              ].join('\n');
            } catch (e) {
              return `没读：${String(e && e.message || e)}`;
            }
          }
          if (a === 'add') {
            const lesson = args?.lesson || (args?.symptom ? {
              symptom: args.symptom, rootCause: args.rootCause, detour: args.detour,
              resolution: args.resolution, prevention: args.prevention, notWhen: args.notWhen,
            } : null);
            const r = addCandidate({
              storeDir, kind: args?.kind || 'lesson', text: args?.text, lesson,
              source: {
                kind: args?.sourceKind || 'failure',
                anchors: args?.sourceAnchor || [],
                speaker: args?.sourceSpeaker || ((args?.kind || 'lesson') === 'preference' ? 'self' : 'master'),
                quote: args?.sourceQuote || '',
              },
              origin: 'manual', risk: args?.risk || 'medium',
              verification: args?.verification || 'unverified',
              answerFor: args?.answerFor || null,
            });
            if (!r.ok) return `没记：${r.error}`;
            return `记下候选 ${r.candidate.id}（${r.candidate.status}）\n` + formatCandidate(r.candidate) +
              '\n\n候选不参加 ask_xi / preactivate；要转正先 show，等他回「同意/可以/签了/转正」。';
          }
          if (a === 'list') {
            let rows = readCandidates(storeDir);
            if (args?.status) rows = rows.filter((c) => c.status === args.status);
            return formatCandidateList(rows, { limit: args?.limit });
          }
          if (a === 'show') {
            const r = showCandidate({ storeDir, id: args?.id, outRawId: args?.outRawId || '', conv: args?.conv || '' });
            if (!r.ok) return `没展示：${r.error}`;
            return r.text + '\n\n（把上面这段原样发出去；等他回同意，再用 approve 带 rawId。）';
          }
          if (a === 'approve') {
            const r = approveCandidate({ storeDir, id: args?.id, rawId: args?.rawId, shownRawId: args?.shownRawId || '' });
            if (!r.ok) return `没签：${r.error}`;
            const next = r.candidate.status === 'trial'
              ? `先试用 30 天（到 ${String(r.candidate.trialUntil || '').slice(0, 10)}），到期 sweep 后再 promote`
              : '下一步 promote 才写记忆层。';
            return `签了 ${r.candidate.id}：${r.candidate.text}\n（approvedBy=${JSON.stringify(r.candidate.approvedBy)}）\n${next}`;
          }
          if (a === 'self-approve') {
            const r = selfApproveCandidate({ storeDir, id: args?.id });
            return r.ok ? `自批了 ${r.candidate.id}（只限 low risk preference）` : `没批：${r.error}`;
          }
          if (a === 'reject') {
            const r = rejectCandidate({ storeDir, id: args?.id, reason: args?.reason || '' });
            return r.ok ? `拒绝了 ${r.candidate.id}，留档不删` : `没拒：${r.error}`;
          }
          if (a === 'promote') {
            const r = promoteCandidate({ storeDir, id: args?.id });
            if (!r.ok) return `没转正：${r.error}`;
            const target = r.lesson?.id || r.fact?.id || r.preference?.id || r.promotedId || r.candidate?.promotedId;
            const where = r.candidate?.promotedTo || 'learning';
            return `转正了 ${target}（${where}）：${r.candidate?.text || r.fact?.text || ''}\n（learnedFrom=${r.candidate?.id || ''}）`;
          }
          if (a === 'sweep') {
            const r = sweepLearning({ storeDir });
            return `扫完：${r.changed} 条状态变了\n` + formatLearnReview({ storeDir });
          }
          return `没做：不认识的 action「${a}」`;
        },
      },
      {
        name: 'xi_review',
        tags: ['write'],
        description:
          '只写处置：sweep 扫生命周期；close-gap 关缺口；resolve-conflict 解冲突。'
          + '看候选/冲突/缺口/到期的只读视图统一用 xi_recap（唯一收件箱），它不再重复列。'
          + '候选不是事实；冲突没解决前不许拿其中一条当准数。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['sweep', 'close-gap', 'resolve-conflict'], description: '默认 sweep' },
            id: { type: 'string', description: 'close-gap / resolve-conflict 的 id' },
            resolution: { type: 'string', description: '怎么处理的' },
          },
          required: [],
        },
        handler: async (args) => {
          const a = String(args?.action || 'sweep');
          const storeDir = this.storeDir;
          if (a === 'sweep') {
            const r = sweepLearning({ storeDir });
            return `扫完：${r.changed} 条状态变了
` + formatLearnReview({ storeDir });
          }
          if (a === 'close-gap') {
            if (!String(args?.id || '').trim()) return '没关：要给 gap id（见 xi_recap 的缺口段）';
            const r = closeGap({ storeDir, id: args?.id, resolution: args?.resolution || '' });
            return r.ok ? `关了缺口 ${r.gap.id}` : `没关：${r.error}`;
          }
          if (a === 'resolve-conflict') {
            if (!String(args?.id || '').trim()) return '没解：要给冲突 id（见 xi_recap 的冲突段）';
            const r = resolveConflict({ storeDir, id: args?.id, resolution: args?.resolution || '' });
            return r.ok ? `解决了冲突 ${r.conflict.id}` : `没解：${r.error}`;
          }
          return `xi_review 只做处置（sweep / close-gap / resolve-conflict）；看账用 xi_recap。`;
        },
      },
      {
        name: 'xi_echo',
        tags: ['read'],
        description:
          '回声账：她把话发出去之后，有没有人回、下一条是不是接这句。只做配对记录，不判断对错。'
          + '规则：同私聊、出站后 30 分钟内的下一条入站；连续出站只配最后一条；没人回标 no-reply，单列不进配对率分母。'
          + 'action=list 看最近；stats 看配对率；sweep 只改未回状态。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'stats', 'sweep'], description: '默认 list' },
            limit: { type: 'integer', description: 'list 条数，默认 20' },
            days: { type: 'integer', description: 'stats 天数，默认 7' },
          },
          required: [],
        },
        handler: async (args) => {
          const a = String(args?.action || 'list');
          if (!['list', 'stats', 'sweep'].includes(a)) {
            // 2026-11-25：原先不认识的 action 直接当 list 回一堆东西，看着像「查到了」。
            return `没做：不认识的 action「${a}」；xi_echo 只有 list / stats / sweep。`;
          }
          if (a === 'sweep') {
            const r = sweepEcho({ storeDir: this.storeDir });
            return `扫完：${r.changed} 条标成 no-reply\n` + formatEcho(r.echoes, { limit: args?.limit });
          }
          if (a === 'stats') {
            // 2026-11-25 01:0x：days=-5 原先照写「最近 -5 天」，读起来像真按 -5 天筛过。
            if (args?.days !== undefined && args?.days !== null) {
              const d = Number(args.days);
              if (!Number.isInteger(d) || d < 1 || d > 365) return `没统计：days 要给 1–365 的整数（收到「${String(args.days).slice(0, 20)}」）`;
            }
            const s = echoStats({ storeDir: this.storeDir, days: args?.days });
            const pct = s.pairRate == null ? '—' : (s.pairRate * 100).toFixed(1) + '%';
            return `【回声账｜最近 ${s.days} 天】出站 ${s.total}｜配上 ${s.paired}｜没人回 ${s.noReply}（不计分母）｜等回 ${s.pending}｜被后一条覆盖 ${s.superseded}｜配对率 ${pct}`;
          }
          return formatEcho(readEcho(this.storeDir), { limit: args?.limit });
        },
      },
      {
        name: 'xi_time',
        tags: ['read'],
        description:
          '现在几点、几号、星期几、属于一天里的哪个时段、今天还剩多久。现算，不读前缀。'
          + '说时间/日期/星期/时段之前先调它；前缀里的时间可能是几小时前写下的。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => nowLine(),
      },
      {
        name: 'xi_job',
        tags: ['write'],
        description:
          '给自己排一件事：到点 xi 会 push 一条内部事件叫醒你，不经过 QQ，也不用等谁开口。'
          + '节律三选一：cron（如 0 10 * * *）、at（YYYY-MM-DDTHH:mm，一次性）、everyMinutes（每 N 分钟，最少 5）。'
          + 'action=add/list/pause/resume/remove；默认 list。到点只做 xi 里的动作，发不发 QQ 由你另判。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list', 'pause', 'resume', 'remove'], description: '默认 list' },
            id: { type: 'string', description: 'pause/resume/remove 的 job id' },
            text: { type: 'string', description: '到点要做什么，写成一句能看懂的话' },
            cron: { type: 'string', description: '5 字段 cron，如 0 10 * * *' },
            at: { type: 'string', description: '一次性本地时间 YYYY-MM-DDTHH:mm' },
            everyMinutes: { type: 'integer', description: '每 N 分钟，最少 5' },
          },
          required: [],
        },
        handler: async (args) => {
          const a = String(args?.action || 'list');
          if (a === 'add') {
            const r = addJob({
              storeDir: this.storeDir, text: args?.text,
              cron: args?.cron, at: args?.at, everyMinutes: args?.everyMinutes,
              owner: 'agent',
            });
            return r.ok ? `排上了：${r.job.id}｜${scheduleText(r.job)}` : `没排上：${r.error}`;
          }
          if (a === 'pause' || a === 'resume' || a === 'remove') {
            // 2026-11-25 01:1x：不给 id 时原先回「没有 undefined」，像在跟一条名为 undefined 的任务说话。
            const id = String(args?.id ?? '').trim();
            if (!id) {
              return a === 'remove'
                ? '没删：要给 id（任务 id，见 xi_job list）'
                : `没${a === 'pause' ? '停' : '开'}：要给 id（任务 id，见 xi_job list）`;
            }
          }
          if (a === 'pause' || a === 'resume') {
            const r = setJobEnabled({ storeDir: this.storeDir, id: args?.id, enabled: a === 'resume' });
            return r.ok ? `${a === 'resume' ? '开了' : '停了'}：${r.job.id}` : `没成：${r.error}`;
          }
          if (a === 'remove') {
            const r = removeJob({ storeDir: this.storeDir, id: args?.id });
            return r.ok ? `删了：${r.id}` : `没删：${r.error}`;
          }
          if (a !== 'list') {
            // 2026-11-25 01:0x：原先不认识的 action 直接当 list 回一堆，看着像「查到了」。
            return `没做：不认识的 action「${a.slice(0, 20)}」；xi_job 只有 add / list / pause / resume / remove。`;
          }
          return formatJobList(this.storeDir);
        },
      },
      {
        name: 'xi_summary',
        tags: ['write'],
        description:
          '跨会话摘要。action=read 看现在那份；action=write 追加一段（带时刻），并记下当时对话条数——'
          + '环境提示里会顶出「距上次摘要已 N 条」，那是我该动笔的信号。摘要写事实和转折，不写感想。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'write'], description: '默认 read' },
            text: { type: 'string', description: 'write 时要追加的摘要正文' },
          },
          required: [],
        },
        handler: async (args) => this.summaryAction(args ?? {}),
      },
    ];
    // 2026-11-25 00:5x：工具层兜底。盘写不进去（EPERM/ENOSPC/占位被改名）时，
    // 原先异常直接穿出 handler，调用方只看到「工具坏了」，分不清是没做成还是库损坏。
    // 统一收成一条诚实回执，并记 collector-errors.log；数据没动就说没动。
    for (const t of list) {
      const h = t.handler;
      if (typeof h !== 'function' || h.__xiSafe) continue;
      const wrapped = async (args) => {
        try { return await h(args); }
        catch (e) {
          this.logError(`tool:${t.name}`, e);
          const code = (e && e.code) ? String(e.code) : '';
          return `（${t.name} 没做成：${code} ${String((e && e.message) || e).slice(0, 200)}；已记 collector-errors.log，这次没写成，库没被改）`;
        }
      };
      wrapped.__xiSafe = true;
      t.handler = wrapped;
    }
    return list;
  }

  /**
   * 待核到期：每次拼前缀都现算一遍，不靠启动那一次、也不靠我记得跑脚本（11-14 21:1x）。
   * 只读 facts.jsonl，不改任何状态；没有到期条就返回 null，整个环境段都不出现。
   */
  buildPendingDue() {
    try {
      const rows = readFileSync(join(this.storeDir, 'facts.jsonl'), 'utf8')
        .split(String.fromCharCode(10)).filter(Boolean);
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const out = [];
      for (const line of rows) {
        let f;
        try { f = JSON.parse(line); } catch { continue; }
        if (f['状态'] !== '待核' || !f['待核到期']) continue;
        const days = Math.round((Date.parse(f['待核到期'] + 'T00:00:00+08:00') - Date.parse(today + 'T00:00:00+08:00')) / 86400000);
        if (!Number.isFinite(days) || days > 0) continue;
        const body = String(f.text || '').replace(/\s+/g, ' ').slice(0, 80);
        out.push('- ' + f.id + '｜到期 ' + f['待核到期'] + '｜晚了 ' + (-days) + ' 天｜主体 ' + (f.subject || '未写') + '｜' + body);
      }
      return out.length ? out.join(String.fromCharCode(10)) : null;
    } catch (e) {
      this.logError('buildPendingDue', e);
      return null;
    }
  }

  /**
   * 桌面区 v0（总纲§一 第四格）：只开第四格，①②③留空。
   * 第四格记「本轮每次 ask() 的返回」，机械映射成人话；不许模型补。
   * 三态：全 answer→空；有非 answer→逐条列；一次都没调→「这一轮没查」。
   */
  /**
   * 读库回执（我 01:35 定）：收据写进读库工具的返回文本，不再走队列。
   * 挂载点是「这一轮读过库」——ask_xi / ask_raw 都算，不止 ask_xi。
   * 只在非 answer 时附；同一问同一结果只附一次；分不清那档只给三条候选、不附陈述。
   */
  withDeskReceipt(out, q) {
    try {
      let o;
      try { o = JSON.parse(out); } catch { return out; }
      if (!o || typeof o !== 'object') return out;
      const 结果 = o['结果'];
      if (!结果 || 结果 === 'answer' || 结果 === 'answered') return out;   // ask_raw 的成功档叫 answered
      const 问 = String(q == null ? '' : q).replace(/\s+/g, ' ').trim().slice(0, 60);
      const 码 = o.code || o['内码'] || '';
      const key = 问 + '|' + 结果 + '|' + 码;
      if (!this._deskSent) this._deskSent = new Set();
      if (this._deskSent.has(key)) return out;
      this._deskSent.add(key);
      this.appendDeskSent(key);
      const lines = ['', '来源：xi-memory 桌面区 v0 · 自动查询，不是谁说的话'];
      const opts = Array.isArray(o['选项']) ? o['选项'].filter((x) => x != null).slice(0, 3) : null;
      if (结果 === 'unrecognized' && 码 === 'ambiguous' && opts && opts.length) {
        lines.push(`问「${问}」`);
        for (const t of opts) {
          const 文案 = typeof t === 'string' ? t : String((t && (t['答案'] || t['text'] || t['正文'])) || JSON.stringify(t));
          lines.push('- ' + 文案.replace(/\s+/g, ' ').slice(0, 60));
        }
        if (o['还有']) lines.push(`- 还有 ${o['还有']} 条`);
      } else {
        lines.push(this.deskMissLine({ 问, 结果, 码, 原因: o['原因'] || '', 后来是: o['后来是'] || '' }));
      }
      return out + lines.join(String.fromCharCode(10));
    } catch (e) {
      this.logError('withDeskReceipt', e);
      return out;
    }
  }

  appendDeskSent(key) {
    try {
      appendFileSync(join(this.storeDir, 'desk-sent.jsonl'), JSON.stringify({ at: new Date().toISOString(), key }) + String.fromCharCode(10));
    } catch (e) { this.logError('appendDeskSent', e); }
  }

  noteDeskAsk(q, o) {
    try {
      if (!q || !o || !o['结果']) return;
      if (!this._deskAsks) this._deskAsks = [];
      if (this._deskAsks.length >= 20) return;
      this._deskAsks.push({ 问: String(q).slice(0, 60), 结果: o['结果'], 码: o.code || o['内码'] || '', 原因: String(o['原因'] || ''), 后来是: o['后来是'] || '' });
    } catch (e) { this.logError('noteDeskAsk', e); }
  }

  deskMissLine(x) {
    const 码 = x.码 ? `（${x.码}）` : '';
    const q = `问「${x.问}」：`;
    if (x.结果 === 'error') return `${q}取用层坏了${码} → 我该说是取用层坏了，这是故障，不许当成没记过`;
    if (x.结果 === 'expired') return `${q}这条后来不成立了${码}${x.后来是 ? `，后面那条是 ${String(x.后来是).replace(/\s+/g, ' ').slice(0, 40)}` : ''} → 我该先说旧值、再说后来改成什么`;
    if (x.结果 === 'unverified') return `${q}记了、没核到原话${码} → 我该说「记了，但没核到原话」，不许当原话讲`;
    if (x.结果 === 'unrecognized') {
      if (x.码 === 'ambiguous') return `${q}分不清是这几条里的哪条${码} → 我该把这几条摆出来让他挑，不许自己挑最近的`;
      if (x.码 === 'no-subject') return `${q}认不出这句在问谁${码} → 我该直说认不出在问谁，问清楚再答，不许猜`;
      if (x.码 === 'no-question-keys') return `${q}这条有内容，但没挂过这个问法${码} → 我该说「这条有内容但没挂过这个问法」，不许拿最像的顶上`;
      return `${q}认不出这句在问什么${码} → 我该直说认不出在问什么，问清楚再答，不许猜`;
    }
    if (x.结果 === 'nosource') {
      if (x.码 === 'empty-class') return `${q}这一类一条都没有${码} → 我该直说这一类没记过`;
      return `${q}这条没记过${码} → 我该直说「这条我没记过」，不许拿最像的顶上`;
    }
    return `${q}${x.结果}${码} → 我该按出口说法照实说，不许换一种讲法`;
  }

  /**
   * 自动查（我 21:21 定）：默认全查，只跳明确不需要的。
   * 理由：最容易编的时候不是被提问，是自己顺嘴带出旧事——「我昨天说的那事办了」
   * 是陈述句，里面每个细节都得靠记忆。按问句形状卡，正好把这种放过去。
   * 所以跳过只有四类：纯表情/纯图片、单字或两三字短句、明确指令。
   */
  deskAutoGate(text) {
    const t = String(text || '').trim();
    if (!t) return { pass: false, why: '空' };
    const body = t.replace(/【[^】]*】/g, ' ').replace(/^[^：]*：/, ' ').trim() || t;
    if (/^\s*\[图片\]|\[blob|\[表情包\]|\[动画表情\]\s*$/.test(body)) return { pass: false, why: '纯媒体' };
    const bare = body.replace(/[\p{P}\p{S}\s]+/gu, '');
    if (!bare) return { pass: false, why: '纯符号' };
    if ([...bare].length <= 3) return { pass: false, why: '太短' };
    if (/^(关机|重启|转发|撤回|复读|别说了|安静|闭嘴)/.test(bare)) return { pass: false, why: '明确指令' };
    return { pass: true, why: '' };
  }

  /** 取本轮最后一条「人说的、还没查过的」消息，自动查一次。 */
  deskAutoAsk() {
    let rows;
    try { rows = this.readRows(); } catch (e) { this.logError('deskAutoAsk:readRows', e); return null; }
    const selfQq = String(this.selfQq() || '');
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - 40; i--) {
      const r = rows[i];
      if (!r || !r.text || r.dir === 'out') continue;
      const sp = r.speaker || {};
      if (String(sp.id || '') === selfQq || sp.name === '我') continue;
      if (r.id === this._deskAutoLast) return null;          // 同一条只查一次
      // 引用头 / 长粘贴不是「他说的一句」，是转贴或长文，不当作本轮问句。
      if (/^\[\d{4}-\d{2}-\d{2}/.test(String(r.text).trim())) continue;
      if (String(r.text).length > 300) continue;
      if (/doc|judgment|seed|non/.test(String(r.scene || ''))) continue;
      const g = this.deskAutoGate(r.text);
      if (!g.pass) { this._deskAutoLast = r.id; this._deskAutoSkip = (this._deskAutoSkip || 0) + 1; return { skip: g.why, id: r.id }; }
      this._deskAutoLast = r.id;
      const 群号 = (String(r.text).match(/群号\s*(\d{5,12})/) || [])[1];
      const conv = r.scene === 'group' && 群号 ? `group:${群号}` : `private:${String(sp.id || '')}`;
      const q = String(r.text).replace(/^【[^】]*】[^：]*：/, '').replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*用户：/, '').trim();
      try { this.ask({ question: q, conv, kind: 'auto' }); } catch (e) { this.logError('deskAutoAsk:ask', e); }
      return { asked: r.id, conv };
    }
    return null;
  }

  renderDeskV0() {
    const asks = this._deskAsks || [];
    const lines = ['【桌面区 v0：只开第四格】'];
    lines.push('【这次没取到什么】');
    if (!asks.length) {
      lines.push('- 这一轮没查（一次 ask 都没调）。这是「没查」，不是「都取到了」。');
    } else {
      const miss = asks.filter((x) => x.结果 !== 'answer');
      if (!miss.length) lines.push('(这一轮问过的都答上了)');
      else for (const x of miss.slice(0, 5)) lines.push('- ' + this.deskMissLine(x));
      if (miss.length > 5) lines.push(`- 另有 ${miss.length - 5} 条同类缺项`);
    }
    this._deskAsks = [];
    return lines.join(String.fromCharCode(10));
  }

  envPromptVars() {
    const due = this.buildPendingDue();
    // 2026-11-22 18:1x：默认关。结果没有消费方（renderDeskV0 全文件无调用点），
    // 只往 ask-log 和 recall-log 里灌噪声；要开在 world 配置里写 deskAutoAsk: true。
    if (this.ctx?.cfg?.deskAutoAsk === true) this.deskAutoAsk();
    // 桌面区只开第四格：前缀每会话只建一次（loop.buildSystem 仅在 bootstrap/交接/清空/显式重载时调用），
    // 每轮拼不进去；11-21 01:42 定：认这个边界，不加 host 钩子，指标改成读库率。
    // 到期段整段（带标题）塞进变量，没到期条就是空串——模板里不留裸占位符，
    // 否则 renderTemplate 会把 {{pendingDue}} 原样端出来（11-21 01:2x 踩过）。
    const pendingDue = due === null
      ? ''
      : ['## 待核到期（只在有条目时出现）',
         '',
         '下面这些记忆条今天到期了。它们是「待核」，不是结论。',
         '',
         '去问主人一句「这条还定不定」，问清了再动。没问到就别说问过，也不许自己把它们改成没源、删掉或者合并。',
         '',
         due].join(String.fromCharCode(10));
    // 关掉 memory 世界之后，短期记忆和摘要由这儿顶：都可能是空串，模板里别留裸占位符。
    const recentTalk = this.buildRecentTalk(12);
    const rollingSummary = this.buildSummaryBlock();
    // 承诺账的「还没了结」：会话开头先看见，不必等她想起来查。
    // 会话中途新落的承诺不会进这段（前缀只建一次），要靠 xi_promise list / recap / review。
    const openLoops = openLoopsBlock(this.storeDir, 5);
    // 学习/账本只给计数，不把候选正文当事实端进前缀。
    let learning = '';
    try {
      const lc = learningCounts(this.storeDir);
      if (lc.pending || lc.trial || lc.dueCandidates || lc.dueLessons || lc.conflicts || lc.gaps) {
        learning = [
          '## 学习/账本（只给计数，不是事实）',
          '',
          `待审候选 ${lc.pending}｜试用 ${lc.trial}｜候选回看 ${lc.dueCandidates}｜到期回看 ${lc.dueLessons}｜冲突 ${lc.conflicts}｜缺口 ${lc.gaps}`,
          '',
          '候选不参加 ask_xi / preactivate（试用候选只可当线索）；要签/转正用 `xi_learn`，看冲突/缺口用 `xi_review`。',
        ].join(String.fromCharCode(10));
      }
    } catch (e) { this.logError('envPromptVars:learning', e); }
    const lessons = lessonsPromptBlock(this.storeDir, 3);
    // P2 投影预算（借 dsh-soul projectionBytes）：动态段总字节封顶，
    // 按优先级整段取舍，绝不把半句教训截断；跳过的段名写进注脚。
    const budget = this.prefixBudgetBytes();
    return this.fitPrefixBudget(
      { lessons, openLoops, pendingDue, learning, recentTalk, rollingSummary },
      budget,
    );
  }

  prefixBudgetBytes() {
    const raw = Number(this.ctx && this.ctx.cfg && this.ctx.cfg.prefixBudgetBytes);
    // 中文按 3 字节/字算：12 行最近对话约 2.4KB，摘要约 3.6KB。默认 3600B
    // 保最近对话 + 教训 + 计数，先舍摘要；要更严在 world 配置里调小。
    if (!Number.isFinite(raw)) return 3600;
    return Math.max(1200, Math.min(6000, Math.round(raw)));
  }

  /** 按 lessons → openLoops → pendingDue → learning → recentTalk → rollingSummary 整段装，装不下就跳过。 */
  fitPrefixBudget(blocks, budget) {
    const order = ['lessons', 'openLoops', 'recentTalk', 'pendingDue', 'learning', 'rollingSummary'];
    const out = {};
    const skipped = [];
    let used = 0;
    for (const key of order) {
      const text = String(blocks[key] || '');
      if (!text) { out[key] = ''; continue; }
      const size = Buffer.byteLength(text, 'utf8');
      // 按优先级贪心：装不下就跳过这一段，继续试更小的段；不因为前面一段大就全丢。
      if (used + size <= budget) {
        out[key] = text;
        used += size;
      } else {
        out[key] = '';
        skipped.push(key);
      }
    }
    if (skipped.length) {
      const anchor = order.find((k) => out[k]);
      if (anchor) {
        const long = `
（前缀投影 ${used}B/${budget}B；跳过：${skipped.join('、')}，要原文用 xi_recap / xi_recent）`;
        const short = `
（投影截断 ${skipped.length} 段）`;
        const pick = used + Buffer.byteLength(long, 'utf8') <= budget ? long
          : used + Buffer.byteLength(short, 'utf8') <= budget ? short : '';
        if (pick) out[anchor] += pick;
      }
    }
    return out;
  }

  evidenceGateForAsk(out, question) {
    const r = String(out && out['结果'] || '');
    const anchor = Boolean(
      (typeof out['出处'] === 'string' && /:\d+/.test(out['出处']))
      || out['条']
      || (typeof out['引文'] === 'string' && out['引文'].trim())
      || (out['出处'] && typeof out['出处'] === 'object' && out['出处'].path),
    );
    let ok = false;
    let reason = '';
    let next = 'say-unknown';
    if (r === 'answer') {
      ok = anchor;
      reason = anchor ? 'ok' : 'no-anchor';
      next = anchor ? 'answer' : 'xi_verify';
      if (out['档'] === '降一档' && !anchor) { reason = 'downgraded-no-anchor'; next = 'xi_verify'; }
    } else if (r === 'expired') {
      reason = 'expired'; next = 'recall-old';
    } else if (r === 'unverified') {
      reason = String(out.code || 'unverified'); next = 'xi_verify';
    } else if (r === 'nosource' || r === 'unrecognized') {
      reason = String(out.code || r); next = 'ask_raw';
    } else if (r === 'error') {
      reason = 'error'; next = 'say-unknown';
    } else {
      reason = String(out.code || r || 'unknown'); next = 'say-unknown';
    }
    // 同一问题连着不够 ≥2 次：换检索路，不再原地重试（engram 的同款建议）。
    if (!this._askMiss) this._askMiss = new Map();
    const key = String(question || '').replace(/[\s，。？！、,.?!]/g, '').slice(0, 120);
    if (key) {
      if (ok) this._askMiss.delete(key);
      else {
        const n = (this._askMiss.get(key) || 0) + 1;
        this._askMiss.set(key, n);
        if (this._askMiss.size > 200) {
          const first = this._askMiss.keys().next().value;
          this._askMiss.delete(first);
        }
        if (n >= 2) { next = 'switch-retrieval'; reason = `${reason};miss-streak=${n}`; }
      }
    }
    return { ok, reason, nextStrategy: next };
  }

  webUi() {
    return {
      label: '记忆采集',
      promptDocs: [
        {
          key: 'worlds.xi-memory.envPrompt',
          title: '记忆采集 · 待核到期',
          description: '到期的待核条端到面前，只提醒、不改状态；没有到期条时整段不出现。',
          role: 'envPrompt',
          path: ENV_PROMPT_FILE,
        },
      ],
    };
  }
}

export default {
  id: 'xi-memory',
  label: '记忆采集',
  defaults: () => ({ enabled: true, deskAutoAsk: false, autoCapturePromises: true, gateEnabled: true, preactivateLimit: 2, selfJobsEnabled: true, autoPreferences: true, autoPromoteFailures: true }),
  create: (ctx) => new XiMemoryWorld(ctx),
};
