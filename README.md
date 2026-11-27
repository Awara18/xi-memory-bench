# xi-memory-bench

A self-contained snapshot of **xi-memory** — a local, file-authoritative conversation
memory layer — published for **聊天记忆挑战赛 2.2** (chat-memory-benchmark, system
`xi-memory`).

The retrieval path is pure local: no model calls, no network. Everything the system
"remembers" lives in plain files under one directory (`workspace/xi-memory/`).

## What is in here

```
src/                 the memory layer itself (ESM, Node >= 20, zero npm dependencies)
  identity.js        names / ids — read from env, never hard-coded
  store.js           paths, atomic-ish read helpers, text normalisation
  index.js           the World plugin: remember(), ask_xi / ask_raw / verify / recap / gate …
  segment.js         Chinese segmentation helper
  facts.js  trace.js  verify.js  recap.js  preactivate.js  brief.js
  promises.js  echo.js  jobs.js  schedule.js  clock.js
  learn.js  reading.js  citations.js  weights.js  gate.js
adapter/
  bridge.mjs         JSON-lines bridge: stdin `{"op":…}` → stdout `{"ok":…}`
  xisys_live.py      benchmark adapter (drop into `bench22/`, register in `systems.py`)
docs/
  安装与接入.md       how to wire it into the benchmark harness
```

## The design in three lines

1. **Files are the authority.** `raw-log.jsonl` holds utterances verbatim; `facts.jsonl`
   holds distilled facts, each anchored to the exact raw line it came from. A fact that
   cannot point back at a raw line does not answer questions.
2. **Recall is local and cheap.** Pre-activation scores raw rows + anchored facts against
   a cue with lexical overlap, time proximity and anchor quality. Nothing leaves the box.
3. **Say "I don't know" out loud.** Every answering path has an explicit refusal: no
   anchor → no answer. The system would rather return nothing than the most similar line.

## Quick start

```bash
node adapter/bridge.mjs          # then feed one JSON request per line on stdin
# {"op":"init","botDir":"/tmp/bot"}
# {"op":"ingest","batch":[{"text":"周六上午去复查","speaker":"用户","scene":"private","ts":"2026-11-27T10:00:00Z","trigger":"at","conv":"private:bench"}]}
# {"op":"retrieve","cue":"周六有什么安排","limit":3}
# {"op":"stats"} / {"op":"truncate","rows":N} / {"op":"quit"}
```

## Configuration

No personal data is compiled in. Everything identity-shaped is read at startup:

| env | meaning | default |
| --- | --- | --- |
| `XI_MASTER_ID` | id of the "owner" side (QQ number or any string) | empty → no id matching |
| `XI_MASTER_NAMES` | aliases of the owner side, comma separated | `主人` |
| `XI_SELF_ID` | id of the assistant side | `self` |
| `XI_SELF_NAMES` | aliases of the assistant side, comma separated | `我` |
| `XI_SRC_DIR` | where `bridge.mjs` looks for `src/` | `../src` beside the script |
| `XI_ENGINE_DIR` | optional TS engine directory for shadow mode | `./xi-memory` |

Per-store values (`master.qq`, `self.qq`, aliases, a private code word) live in
`<store>/identity.json`, which is not shipped.

## License

MIT — see `LICENSE`.
