// xi-live-bridge.mjs —— 把线上 xi 插件本体当检索后端用（不是移植，是原代码）
//
// 走的是插件自己的两条公开路径：
//   w.remember({text, speaker, scene, ts, trigger, conv})   —— 采集（原话落 raw-log）
//   loadPreactivation({storeDir, botDir, cue, limit})       —— 开口前预激活（纯本地，不调模型、不联网）
//
// 协议：stdin 一行一条 JSON 请求，stdout 一行一条 JSON 回包。
//   {"op":"init","botDir":"..."}                        -> {ok, storeDir}
//   {"op":"ingest","batch":[{text,speaker,ts,trigger,conv}]}  -> {ok, ids:[...]}
//   {"op":"retrieve","cue":"...","limit":3}             -> {ok, cands:[...], text}
//   {"op":"truncate","rows":N}                          -> {ok, rows}
//   {"op":"stats"}                                      -> {ok, rows}
//   {"op":"quit"}                                       -> {ok}
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";

// 默认按「脚本旁边 ../src」找，换机器不用改代码；要指别处就设 XI_SRC_DIR。
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.env.XI_SRC_DIR || join(HERE, "..", "src");
const XI = join(SRC_DIR, "index.js");
const XI_PRE = join(SRC_DIR, "preactivate.js");

const mod = (await import(pathToFileURL(XI).href)).default;
const { loadPreactivation } = await import(pathToFileURL(XI_PRE).href);

let w = null;
let storeDir = null;
let botDir = null;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function doInit(b) {
  botDir = b;
  storeDir = join(botDir, "workspace", "xi-memory");
  mkdirSync(storeDir, { recursive: true });
  const facts = join(storeDir, "facts.jsonl");
  if (!existsSync(facts)) writeFileSync(facts, "", "utf8");
  w = mod.create({ botDir });
  if (w.storeDir !== storeDir) throw new Error(`storeDir 不一致: ${w.storeDir} != ${storeDir}`);
  out({ ok: true, storeDir });
}

function doIngest(batch) {
  const ids = [];
  for (const r of batch) {
    const res = w.remember({
      text: r.text, speaker: r.speaker, scene: r.scene || "private",
      ts: r.ts, trigger: r.trigger, conv: r.conv,
    });
    const s = String(res);
    const m = /记下了\s*(r\d+)/.exec(s);
    ids.push(m ? m[1] : null);
    if (!m) process.stderr.write("INGEST-REJECT: " + s.slice(0, 120) + "\n");
  }
  out({ ok: true, ids });
}

function doRetrieve(cue, limit) {
  const r = loadPreactivation({ storeDir, botDir, cue, limit: Number(limit) || 3 });
  out({ ok: true, cands: r.candidates, text: r.text, dataTo: r.dataTo });
}

function doTruncate(rows) {
  const p = join(storeDir, "raw-log.jsonl");
  const buf = readFileSync(p, "utf8").split("\n");
  const keep = rows > 0 ? buf.slice(0, rows) : [];
  writeFileSync(p, keep.length ? keep.join("\n") + "\n" : "", "utf8");
  w._rawIndex = null;
  const n = readFileSync(p, "utf8").split("\n").filter((x) => x.trim()).length;
  out({ ok: true, rows: n });
}

function doStats() {
  const p = join(storeDir, "raw-log.jsonl");
  const n = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((x) => x.trim()).length : 0;
  out({ ok: true, rows: n });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch (e) { out({ ok: false, error: "bad json" }); return; }
  try {
    switch (req.op) {
      case "init": doInit(req.botDir); break;
      case "ingest": doIngest(req.batch || []); break;
      case "retrieve": doRetrieve(req.cue, req.limit); break;
      case "truncate": doTruncate(req.rows); break;
      case "stats": doStats(); break;
      case "quit": out({ ok: true }); process.exit(0); break;
      default: out({ ok: false, error: "unknown op " + req.op });
    }
  } catch (e) {
    out({ ok: false, error: String(e && e.stack || e).slice(0, 500) });
  }
});
