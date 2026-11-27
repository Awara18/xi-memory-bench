/**
 * 钟点与时段。直接照抄 cortico-world-clock-alont1 的 src/clock.ts（MIT）。
 * 只保留纯函数：时段判定、日期/时刻排版、一天进度。
 *
 * 分时段不是为了替谁决定做什么，只是把人看钟点时会顺手做的那层解释补上：
 * 「23:40」是数字，「深夜」才是“该睡了”。
 */

export const PERIOD_STARTS = [
  { name: '凌晨', from: 1 },
  { name: '清晨', from: 5 },
  { name: '上午', from: 8 },
  { name: '中午', from: 11 },
  { name: '下午', from: 13 },
  { name: '傍晚', from: 17 },
  { name: '晚上', from: 19 },
  { name: '深夜', from: 23 },
];

export const PERIOD_NOTES = {
  凌晨: '一天里最安静的一段，人通常已经睡了；还没睡就是熬过头了。',
  清晨: '天刚亮，多数人还在睡。',
  上午: '白天的正事时间，人可能不在。',
  中午: '饭点。',
  下午: '白天的正事时间，人可能不在。',
  傍晚: '收工前后。',
  晚上: '一天里最闲的一段，人通常在。',
  深夜: '该睡了。',
};

export function periodOf(hour) {
  let name = '深夜';
  for (const p of PERIOD_STARTS) {
    if (hour >= p.from) name = p.name;
  }
  return name;
}

/** `2026-09-21T13:24:00+08:00` → `9月21日`。 */
export function chineseDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso.slice(0, 10);
  return `${Number(m)}月${Number(d)}日`;
}

/** `2026-09-21T13:24:00+08:00` → `13:24`。 */
export function clockOf(iso) {
  return iso.slice(11, 16);
}

/** 一天的进度：已经过去多少分钟、还剩多少分钟。 */
export function dayProgress(iso) {
  const h = Number(iso.slice(11, 13));
  const m = Number(iso.slice(14, 16));
  const passed = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return { passedMinutes: passed, leftMinutes: Math.max(0, 1440 - passed) };
}

/** 分钟数说成人话：95 → `1 小时 35 分`。 */
export function humanMinutes(total) {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m - h * 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

export function clockLine(iso, weekday) {
  const period = periodOf(Number(iso.slice(11, 13)));
  return `${chineseDate(iso)} ${clockOf(iso)} ${weekday}，${period}`;
}

/** 当前时区的 ISO 本地时刻（不依赖进程时区）。 */
function localIso(timezone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function weekdayOf(timezone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'short' }).format(new Date());
}

/**
 * 一整段现算的人话。时间永远现算；不要拿前缀里那行当准的。
 */
export function nowLine(timezone = 'Asia/Shanghai') {
  const iso = localIso(timezone);
  const period = periodOf(Number(iso.slice(11, 13)));
  const { leftMinutes } = dayProgress(iso);
  return `现在是 ${clockLine(iso, weekdayOf(timezone))}。${PERIOD_NOTES[period]}今天还剩 ${humanMinutes(leftMinutes)}。`;
}
