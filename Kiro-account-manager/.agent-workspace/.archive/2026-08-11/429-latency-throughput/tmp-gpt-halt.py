"""
Why do GPT-model requests stop mid-task while Opus does not?

User report: agent halts partway ("17 tools, 158s, half done"), no error surfaced.
Hypotheses to separate with real data:
  H1 rate limiting  -> expect 429 / "Rate limited" near the cut
  H2 upstream terminal disposition (CONTENT_FILTERED / abnormal end) -> 502 path
  H3 stream just ENDS with a stop_reason that means "I'm done" (tool_use/max_tokens)
     while the client expected more -> no error at all, silently truncated
  H4 silent-watchdog / idle timeout kicked in
"""
import json, re
from collections import Counter, defaultdict
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
def t(r): return datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
print(f"rows={len(rows)}  {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")

# ---- which models appear, and how do they end? ----
MODEL = re.compile(r"model=([\w.\-:]+)")
print("\n=== models seen in logs ===")
print(" ", Counter(m.group(1) for r in rows
                   for m in [MODEL.search(r.get("message") or "")] if m).most_common(12))

TERM = re.compile(r"CONTENT_FILTERED|terminated abnormally|content filter|truncated|"
                  r"disposition|stop_reason|stopReason|max_tokens|end_turn|tool_use",
                  re.I)
hits = [r for r in rows if TERM.search(r.get("message") or "")]
print(f"\n=== termination-related rows: {len(hits)} ===")
for shape, n in Counter(re.sub(r"\d+", "N", (h.get("message") or ""))[:130]
                        for h in hits).most_common(20):
    print(f"  {n:5d}x {shape}")

print("\n=== chronological (last 40) ===")
for r in hits[-40:]:
    d = r.get("data")
    extra = ""
    if isinstance(d, dict):
        keep = {k: v for k, v in d.items() if k in
                ("model", "disposition", "stopReason", "reason", "account",
                 "toolUses", "outputTokens", "terminal")}
        if keep: extra = "  " + json.dumps(keep, ensure_ascii=False)[:200]
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):12s} "
          f"{(r.get('message') or '')[:150]}{extra}")

# ---- silent watchdog / idle ----
print("\n=== silent watchdog / idle-abort events ===")
WD = re.compile(r"watchdog|静默|idle|no chunk|无数据|silent", re.I)
wd = [r for r in rows if WD.search(r.get("message") or "")]
print(f"  {len(wd)} rows")
for r in wd[-20:]:
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {(r.get('message') or '')[:160]}")

# ---- per-model outcome from [Perf] lines + request logs ----
RQ = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-request-logs.json"
try:
    reqs = json.load(open(RQ, encoding="utf-8"))
    print(f"\n=== request log: outcome by model ({len(reqs)} rows) ===")
    g = defaultdict(lambda: Counter())
    tok = defaultdict(list)
    for r in reqs:
        m = (r.get("model") or "?")
        g[m][r.get("status")] += 1
        if r.get("status") == 200 and r.get("outputTokens") is not None:
            tok[m].append(r["outputTokens"])
    for m in sorted(g):
        out = tok[m]
        med = sorted(out)[len(out)//2] if out else 0
        small = sum(1 for x in out if x < 50)
        print(f"  {m:28s} {dict(g[m])}  out_tok median={med:6d}  "
              f"suspiciously_small(<50)={small}/{len(out)}")
except Exception as e:
    print(f"  (request log unavailable: {e})")
