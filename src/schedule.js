/**
 * 排班：5 字段 cron、一次性 at、间隔 every 的解析与下次触发。
 *
 * 从 cortico-world-agenda@0.2.3（MIT）的 cron.ts / schedule.ts 摘出来，去类型、改成 ESM。
 * 只做标准子集：`* , - /` 与纯数字，周字段 0 与 7 都算周日；不支持 MON/L/W/?。
 * 时间一律按本机时区算（中国无 DST）。
 */

const FIELD_SPECS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
];

function parseField(spec, raw) {
  const table = new Array(spec.max + 1).fill(false);
  for (const term of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term.trim());
    if (!m) throw new Error(`cron ${spec.name}字段的「${term}」看不懂：只认数字、区间(a-b)、*(以及后面的 /步长)`);
    const [, rangePart, stepPart] = m;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${spec.name}字段的步长「/${stepPart}」得是正整数`);
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : spec.max;
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron ${spec.name}字段的范围「${rangePart}」越界：合法是 ${spec.min}-${spec.max}`);
    }
    for (let v = lo; v <= hi; v += step) table[v] = true;
  }
  const restricted = raw.trim() !== '*';
  return { table, restricted };
}

export function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 要 5 个字段（分 时 日 月 周），「${String(expr ?? '').trim()}」是 ${fields.length} 个`);
  }
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseField(FIELD_SPECS[0], minF);
  const hour = parseField(FIELD_SPECS[1], hourF);
  const dom = parseField(FIELD_SPECS[2], domF);
  const month = parseField(FIELD_SPECS[3], monF);
  const dow = parseField(FIELD_SPECS[4], dowF);
  if (dow.table[7]) dow.table[0] = true;
  const join = (f, min, max) => {
    const vals = [];
    for (let v = min; v <= max; v++) if (f.table[v]) vals.push(v);
    return vals.length === max - min + 1 ? '*' : vals.join(',');
  };
  return {
    minute: minute.table,
    hour: hour.table,
    dom: dom.table,
    month: month.table,
    dow: dow.table,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
    normalized: [
      join(minute, 0, 59),
      join(hour, 0, 23),
      join(dom, 1, 31),
      join(month, 1, 12),
      join(dow, 0, 6),
    ].join(' '),
  };
}

export function cronMatches(p, at) {
  if (!p.month[at.getMonth() + 1]) return false;
  const dayOk = p.dom[at.getDate()];
  const dowOk = p.dow[at.getDay()];
  if (p.domRestricted && p.dowRestricted) {
    if (!dayOk && !dowOk) return false;
  } else if (p.domRestricted) {
    if (!dayOk) return false;
  } else if (p.dowRestricted) {
    if (!dowOk) return false;
  }
  return Boolean(p.hour[at.getHours()] && p.minute[at.getMinutes()]);
}

/** 严格晚于 from 的下次触发；到不了（如 2 月 30 日）返回 null。 */
export function nextFire(p, from, horizonYears = 5) {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const dayLimit = Math.ceil(horizonYears * 366) * 2;
  for (let day = 0; day < dayLimit; day++) {
    if (!p.month[t.getMonth() + 1]) {
      t.setDate(1);
      t.setHours(0, 0, 0, 0);
      t.setMonth(t.getMonth() + 1);
      continue;
    }
    const dayOk = p.dom[t.getDate()];
    const dowOk = p.dow[t.getDay()];
    const hit = p.domRestricted && p.dowRestricted
      ? dayOk || dowOk
      : p.domRestricted
        ? dayOk
        : p.dowRestricted
          ? dowOk
          : true;
    if (!hit) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    for (let h = t.getHours(); h < 24; h++) {
      if (!p.hour[h]) continue;
      for (let m = h === t.getHours() ? t.getMinutes() : 0; m < 60; m++) {
        if (p.minute[m]) return new Date(t.getFullYear(), t.getMonth(), t.getDate(), h, m);
      }
    }
    t.setDate(t.getDate() + 1);
    t.setHours(0, 0, 0, 0);
  }
  return null;
}

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseAt(raw) {
  if (!AT_PATTERN.test(String(raw ?? ''))) {
    throw new Error(`at 要「YYYY-MM-DDTHH:mm」的本地时间，例如 2026-09-19T21:30，收到「${raw}」`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`at 的「${raw}」不是一个真实存在的时间`);
  // new Date('2026-02-30T10:00') 会滚到 3 月 2 日，不能静默接受。
  if (formatAt(d) !== String(raw)) {
    throw new Error(`at 的「${raw}」不是真实存在的日期（会滚成 ${formatAt(d)}）`);
  }
  return d;
}

const pad = (n) => String(n).padStart(2, '0');

export function formatAt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function floorToMinute(d) {
  const t = new Date(d.getTime());
  t.setSeconds(0, 0);
  return t;
}

function parseTs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

/** 排班锚点：anchorAt → lastFiredAt → createdAt。 */
export function anchorOf(job) {
  const raw = parseTs(job.anchorAt) ?? parseTs(job.lastFiredAt) ?? parseTs(job.createdAt);
  return raw === null ? null : floorToMinute(raw);
}

const cronCache = new Map();

export function parsedCron(expr) {
  let p = cronCache.get(expr);
  if (p === undefined) {
    try {
      p = parseCron(expr);
    } catch (err) {
      p = err instanceof Error ? err : new Error(String(err));
    }
    cronCache.set(expr, p);
  }
  return p;
}

export function nextEvery(anchor, minutes) {
  return new Date(anchor.getTime() + minutes * 60_000);
}

export function nextScheduled(job, anchor) {
  if (job.kind === 'once') {
    if (!job.at) return null;
    try { return parseAt(job.at); } catch { return null; }
  }
  if (job.kind === 'every') {
    const min = job.everyMinutes;
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) return null;
    return nextEvery(anchor, min);
  }
  if (job.cron === undefined) return null;
  const p = parsedCron(job.cron);
  return p instanceof Error ? null : nextFire(p, anchor);
}

export function missedSlots(job, anchor, now) {
  if (job.kind === 'every') {
    const min = job.everyMinutes ?? 0;
    if (min < 1) return { count: 1, capped: false };
    return { count: Math.max(1, Math.floor((now.getTime() - anchor.getTime()) / (min * 60_000))), capped: false };
  }
  if (job.cron === undefined) return { count: 1, capped: false };
  const p = parsedCron(job.cron);
  if (p instanceof Error) return { count: 1, capped: false };
  let from = anchor;
  let count = 0;
  while (count < 500) {
    const next = nextFire(p, from);
    if (next === null || next.getTime() > now.getTime()) break;
    from = next;
    count += 1;
  }
  return { count: Math.max(1, count), capped: count >= 500 };
}

export function intervalText(minutes) {
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 校验间隔。minMinutes 默认 5。 */
export function checkEveryMinutes(value, minMinutes = 5) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'everyMinutes 要一个整数分钟数（40 = 每 40 分钟，120 = 每 2 小时）。' };
  }
  if (n > 43_200) return { ok: false, error: '间隔最多 43,200 分钟（30 天），收到 ' + n + '；要更疏就用 cron。' };
  if (n < minMinutes) return { ok: false, error: `间隔至少 ${minMinutes} 分钟（收到 ${n}）。` };
  return { ok: true, minutes: n };
}

export function scheduleText(job) {
  if (job.kind === 'once') return `一次性 ${job.at ?? '?'}`;
  if (job.kind === 'every') return job.everyMinutes === undefined ? '每 ? 分钟' : intervalText(job.everyMinutes);
  const p = parsedCron(job.cron ?? '');
  return p instanceof Error ? `节律 ${job.cron ?? '?'}（看不懂）` : `节律 ${p.normalized}`;
}
