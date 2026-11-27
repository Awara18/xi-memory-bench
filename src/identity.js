/**
 * identity.js —— 身份不写死在代码里。
 *
 * 早一版把「主人的 QQ」「自己的名字」直接写进了各处逻辑；开源出去等于把这些挂公网。
 * 现在统一从这里读：优先环境变量，其次 identity.json（各调用点自己把值传进来）；
 * 代码里只留中性占位。
 *
 * 环境变量：
 *   XI_MASTER_ID     主人一方的 id（QQ 号或任意串）。留空则不做 id 比对。
 *   XI_MASTER_NAMES  主人一方的所有规范名，逗号分隔（默认「主人」）。
 *   XI_SELF_ID       本工具自己的 id（默认 self）。
 *   XI_SELF_NAMES    本工具自己的名字，逗号分隔（默认「我」）。
 */

const csv = (v, fallback) => {
  const arr = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : fallback;
};

export const MASTER_ID = String(process.env.XI_MASTER_ID || '').trim();
export const SELF_ID = String(process.env.XI_SELF_ID || 'self').trim();
export const MASTER_NAMES = csv(process.env.XI_MASTER_NAMES, ['主人']);
export const SELF_NAMES = csv(process.env.XI_SELF_NAMES, ['我']);
export const SELF_NAME = SELF_NAMES[0];

const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 名字并成一条正则片段，给 `new RegExp(...)` 用。 */
export const MASTER_ALT = MASTER_NAMES.map(esc).join('|');
export const SELF_ALT = SELF_NAMES.map(esc).join('|');

/** 「|有的话再拼上一个 id」，id 为空就返回空串。 */
export const idAlt = (id) => (id ? '|' + esc(id) : '');
