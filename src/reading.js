/**
 * reading.js —— 网页正文读取（总纲第 5 块 reading 的最小实现）。
 *
 * 原则：
 * - 只读公开 http(s) 页面；不碰 localhost / IP / 带账号的 URL。
 * - 只做“抓正文 → 产 reading 候选”，不自动转正、不写 facts。
 * - 正文是材料，不是原话；候选里带 URL 与摘录，转正时落 books/note-*.md。
 *
 * 这里不依赖浏览器或第三方解析库：先抓 HTML，做保守的正文清洗；
 * 动态页/付费墙读不到就报错，不编造。
 */
import { isIP } from 'node:net';
import { addCandidate } from './learn.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 4;
const MAX_TEXT = 12000;

export function validateReadUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 8192) throw new Error('URL 为空或过长');
  let u;
  try { u = new URL(s); } catch { throw new Error('需要完整的 http(s) URL'); }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('只允许公开的 http(s) 页面，不能带账号密码');
  }
  if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')
    || /(^|\.)(localhost|local|localdomain|internal|lan|home|onion)$/.test(host)) {
    throw new Error('只允许公开域名，不能读本地、IP 或内网地址');
  }
  u.hostname = host;
  return u;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function plain(html) {
  let body = String(html ?? '');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
  body = body.replace(/<h[1-3]\b[^>]*>/gi, '\n');
  body = body.replace(/<li\b[^>]*>/gi, '- ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);
  return body
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractHtml(html, url = '') {
  const raw = String(html ?? '');
  const titleMatch = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = plain(titleMatch?.[1] || h1Match?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    || (url ? new URL(url).hostname : '未命名网页');

  let main = raw;
  const article = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (article) main = article[1];

  let text = plain(main);
  if (!article && text.length < 80) text = plain(raw);
  text = text.slice(0, MAX_TEXT).trim();
  if (text.length < 40) throw new Error('没读到可用正文（可能是动态页、登录页或纯图片）');

  const paras = text.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 20);
  const excerpt = (paras.slice(0, 3).join(' ') || text).slice(0, 300);
  return { title, text, excerpt };
}

export async function readUrl(input, { timeoutMs = 12000, maxBytes = 2_000_000 } = {}) {
  let current = validateReadUrl(input);
  const signal = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 12000));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.href, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`重定向 ${res.status} 没有 Location`);
      if (hop === MAX_REDIRECTS) throw new Error('重定向次数过多');
      current = validateReadUrl(new URL(location, current).href);
      continue;
    }
    if (!res.ok) throw new Error(`网页返回 HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (type && !/text\/html|application\/xhtml\+xml|text\/plain|text\/markdown/.test(type)) {
      throw new Error(`不支持的页面类型：${type.split(';')[0]}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`网页太大（${bytes.length} 字节，上限 ${maxBytes}）`);
    const html = bytes.toString('utf8');
    if (/text\/plain|text\/markdown/.test(type)) {
      const text = html.replace(/\r/g, '').trim().slice(0, MAX_TEXT);
      if (text.length < 40) throw new Error('没读到可用正文');
      const paras = text.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 20);
      return {
        url: current.href, title: current.hostname, text,
        excerpt: (paras.slice(0, 3).join(' ') || text).slice(0, 300),
        bytes: bytes.length, fetchedAt: new Date().toISOString(),
      };
    }
    const got = extractHtml(html, current.href);
    return {
      ...got, url: current.href, bytes: bytes.length, fetchedAt: new Date().toISOString(),
    };
  }
  throw new Error('重定向次数过多');
}

/**
 * 读一个 URL 并产 reading 候选；不转正、不写 facts。
 * 同一 URL 重复调用会命中候选去重，返回原候选。
 */
export async function readUrlCandidate({ storeDir, url, now } = {}) {
  const page = await readUrl(url);
  const added = addCandidate({
    storeDir,
    kind: 'reading',
    text: `《${page.title}》`,
    source: { kind: 'url', anchors: [page.url], speaker: 'master', quote: page.excerpt },
    origin: 'reading',
    risk: 'low',
    verification: 'unverified',
    now,
  });
  if (!added.ok) return { ...page, ok: false, error: added.error };
  return {
    ...page, ok: true, candidate: added.candidate, duplicate: Boolean(added.duplicate),
  };
}
