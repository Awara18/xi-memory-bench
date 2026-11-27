/**
 * 仅用于切词的中文分词层。
 * 词表借自 jieba 的 dict.txt（词 + 词频）；这里只做最大概率切分，不做同义/语义扩展。
 * 人名、群名、片名由调用方传入，先于词表整体保护，保证不被切开。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DICT_URL = new URL('../data/jieba-dict.txt', import.meta.url);
let DICT = null;
let MAXLEN = 1;
let LOGTOTAL = 0;

function loadDict() {
  if (DICT) return;
  const map = new Map();
  let total = 0;
  let maxLen = 1;
  const text = readFileSync(fileURLToPath(DICT_URL), 'utf8');
  for (const line of text.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const w = line.slice(0, sp);
    const f = parseInt(line.slice(sp + 1, line.indexOf(' ', sp + 1)), 10);
    if (!w || !Number.isFinite(f) || f <= 0) continue;
    map.set(w, f);
    total += f;
    if (w.length > maxLen) maxLen = w.length;
  }
  DICT = map;
  MAXLEN = Math.min(maxLen, 16);
  LOGTOTAL = Math.log(total || 1);
}

/** 去掉标点/空白，只留字母数字汉字，和 askRawTerms 的清洗口径一致。 */
export function normForSeg(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 词表里是否有这个整词（只用于判断「是不是词典已知词」，不做语义扩展）。 */
export function isDictWord(w) {
  loadDict();
  return DICT.has(String(w || '').normalize('NFKC').toLowerCase());
}

/**
 * @param {string} text 已清洗的文本（可含空格）
 * @param {string[]} names 需要整体保留的名字（已清洗）
 * @returns {string[]} 词序列
 */
export function segmentText(text, names = []) {
  loadDict();
  const s = String(text || '');
  const nameSet = new Set(names.filter((n) => n && n.length >= 2));
  const maxName = names.reduce((m, n) => Math.max(m, (n || '').length), 0);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const hit = findName(s, i, nameSet, maxName);
    if (hit) {
      if (hit.at > i) out.push(...segmentPlain(s.slice(i, hit.at)));
      out.push(hit.name);
      i = hit.at + hit.name.length;
    } else {
      out.push(...segmentPlain(s.slice(i)));
      break;
    }
  }
  return out;
}

/** 从 i 起找最早出现的名字；同位置取最长。ASCII 名字要求字母数字边界，避免在长数字里误伤。 */
function findName(s, from, nameSet, maxName) {
  for (let p = from; p < s.length; p++) {
    for (let l = Math.min(maxName, s.length - p); l >= 2; l--) {
      const cand = s.slice(p, p + l);
      if (!nameSet.has(cand)) continue;
      if (/^[a-z0-9]+$/.test(cand)) {
        const before = s[p - 1] || '';
        const after = s[p + l] || '';
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      }
      return { at: p, name: cand };
    }
  }
  return null;
}

/** 不含名字的普通片段：空格跳过，ASCII 串整体保留，汉字段走 DP。 */
function segmentPlain(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || !/[\p{L}\p{N}]/u.test(ch)) { i++; continue; }
    const m = /^[a-z0-9]+/.exec(s.slice(i));
    if (m) { out.push(m[0]); i += m[0].length; continue; }
    let j = i;
    while (j < s.length && /[\u3400-\u9fff\uf900-\ufaff]/.test(s[j])) j++;
    if (j === i) { out.push(ch); i++; continue; }
    out.push(...dp(s.slice(i, j)));
    i = j;
  }
  return out;
}

function dp(run) {
  const n = run.length;
  const best = new Array(n + 1).fill(-Infinity);
  const back = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === -Infinity) continue;
    const maxL = Math.min(MAXLEN, n - i);
    for (let l = 1; l <= maxL; l++) {
      const w = run.slice(i, i + l);
      const f = DICT.get(w);
      let sc;
      if (f) sc = best[i] + Math.log(f) - LOGTOTAL;
      else if (l === 1) sc = best[i] + Math.log(1) - LOGTOTAL; // 单字兜底
      else continue;
      if (sc > best[i + l]) { best[i + l] = sc; back[i + l] = w; }
    }
  }
  const words = [];
  let p = n;
  while (p > 0) {
    const w = back[p];
    if (!w) { words.unshift(run[p - 1]); p--; continue; }
    words.unshift(w);
    p -= w.length;
  }
  return words;
}
