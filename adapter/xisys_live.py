# -*- coding: utf-8 -*-
"""xi-live：直接驱动线上 xi 插件本体（不是移植）。

和 xisys.py（xi-attitude，移植版）的区别：
  · 记忆写入走插件自己的 remember()，落 raw-log.jsonl，格式/轮次/说话人/时间都由插件决定；
  · 检索走插件自己的 loadPreactivation()（xi_preactivate 工具背后的同一个函数），
    纯本地、不调模型、不联网，输出就是助手开口前真会看到的那两三条候选；
  · 所以这里量的是「xi 现在这套代码挑不挑得中」，不是「我照它的意思重写的 BM25 行不行」。

两个必须说清的口径（写进 meta，报告里照抄）：
  1. 候选正文给全。preactivate 为了界面上那两行，把原话截到 110 字；这里用整轮。
  2. 最近 6 轮照给。xi 的预激活故意跳过最近 12 条原话（「前缀里已经有最近的」），
     它假设最近几轮一定在上下文里。外部尺子把上下文清零，所以由适配器把最近 6 轮补上，
     跟 bm25-recent6 同一个 recent 窗口；不然量到的是「它没拿到最近六轮」而不是「它推得准不准」。

环境变量：
  XI_LIVE_LIMIT   推几条候选，默认 3（插件工具层上限也是 3）
  XI_LIVE_RECENT  最近窗口几轮，默认 6；-1 关掉
  XI_SELF_NAME    助手一侧写进库时用的名字，默认「我」
  XI_LIVE_HINT=1  把 preactivate 那段「候选，不是原话，不是证据」原文也塞进 prompt（消融用）
  XI_LIVE_BOT     每个 persona 的临时库根目录（默认落在系统临时目录）
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import sys

from .systems import Retrieval, System, render, RECENT

NODE = os.environ.get("XI_LIVE_NODE", "node")
# bridge.mjs 默认就在这个文件旁边（adapter/ 一起提交），不用改代码。
BRIDGE = os.environ.get(
    "XI_LIVE_BRIDGE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.mjs"),
)
SELF_NAME = os.environ.get("XI_SELF_NAME", "我")
LIMIT = int(os.environ.get("XI_LIVE_LIMIT", "3"))
RECENT_N = int(os.environ.get("XI_LIVE_RECENT", "6"))
HINT = os.environ.get("XI_LIVE_HINT", "0") == "1"


class XiLive(System):
    name = "xi-live"

    def __init__(self, bot_dir=None):
        tag = f"xi-live-{os.getpid()}-{id(self) % 100000}"
        self.bot_dir = bot_dir or os.path.join(
            os.environ.get("XI_LIVE_BOT", os.path.join(tempfile.gettempdir(), "xi-live-store")), tag)
        self.proc = subprocess.Popen(
            [NODE, BRIDGE, self.bot_dir],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.turns = []
        self.id2turn = {}
        self.rows = 0
        r = self._rpc({"op": "init", "botDir": self.bot_dir})
        if not r.get("ok"):
            raise RuntimeError("xi-live bridge init failed: " + str(r)[:300])
        self.store_dir = r.get("storeDir")

    # ---- bridge plumbing
    def _rpc(self, obj):
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read()[:800] if self.proc.stderr else ""
            raise RuntimeError("xi-live bridge died: " + err)
        return json.loads(line)

    # ---- System contract
    def ingest(self, turn):
        idx = len(self.turns)
        self.turns.append(turn)
        conv = "private:bench"
        ts = str(turn.get("time") or "")
        batch = [
            {"text": turn["user"], "speaker": "用户", "scene": "private", "ts": ts, "trigger": "at", "conv": conv},
            {"text": turn["assistant"], "speaker": SELF_NAME, "scene": "private", "ts": ts, "trigger": "self", "conv": conv},
        ]
        r = self._rpc({"op": "ingest", "batch": batch})
        if not r.get("ok"):
            raise RuntimeError("xi-live ingest failed: " + str(r)[:300])
        for rid in r.get("ids") or []:
            if rid:
                self.id2turn[rid] = idx
                self.rows += 1

    def mark(self):
        return (len(self.turns), self.rows)

    def rewind(self, token):
        n_turns, n_rows = token
        del self.turns[n_turns:]
        self.id2turn = {k: v for k, v in self.id2turn.items() if v < n_turns}
        r = self._rpc({"op": "truncate", "rows": n_rows})
        if not r.get("ok"):
            raise RuntimeError("xi-live truncate failed: " + str(r)[:300])
        self.rows = r.get("rows", n_rows)

    def retrieve(self, question, now, cutoff_turn, item_id=None):
        r = self._rpc({"op": "retrieve", "cue": question, "limit": LIMIT})
        if not r.get("ok"):
            raise RuntimeError("xi-live retrieve failed: " + str(r)[:300])
        n = len(self.turns)
        picks = []
        detail = []
        for c in r.get("cands") or []:
            idx = self.id2turn.get(str(c.get("id") or ""))
            detail.append({"kind": c.get("kind"), "id": c.get("id"), "score": c.get("score"), "turn": idx})
            if idx is not None and idx < n:
                picks.append(idx)
        picks = sorted(set(picks))
        recent = list(range(max(0, n - RECENT_N), n)) if RECENT_N >= 0 else []
        text = render([self.turns[i] for i in picks], [self.turns[i] for i in recent], now, "base")
        if HINT and r.get("text"):
            text = text + "\n\n" + str(r["text"])
        used = sorted({self.turns[i]["turn"] for i in picks} | {self.turns[i]["turn"] for i in recent})
        meta = {"xi_candidates": detail, "picked_turns": [self.turns[i]["turn"] for i in picks],
                "recent_turns": [self.turns[i]["turn"] for i in recent],
                "xi_limit": LIMIT, "xi_recent": RECENT_N, "xi_hint": HINT,
                "xi_block": (r.get("text") or "")[:1200]}
        return Retrieval(text, used, meta)
