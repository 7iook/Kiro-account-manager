"""
The screenshot window (02:10-02:17 local = 18:10-18:17 UTC) is USER traffic right
after my experiment ended (~02:09). It contains the 503/500 failures I never
reproduced. Extract the ground truth for that window.
"""
import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
print(f"log rows={len(rows)} first={rows[0]['timestamp']} last={rows[-1]['timestamp']}")

RE = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

LO = datetime(2026, 8, 10, 18, 5, tzinfo=timezone.utc)
HI = datetime(2026, 8, 10, 19, 0, tzinfo=timezone.utc)

win = [r for r in rows
       if LO <= datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")) <= HI]
print(f"\nrows in screenshot window: {len(win)}")

perf = []
for r in win:
    x = RE.search(r.get("message", "") or "")
    if x:
        perf.append(dict(ts=r["timestamp"], ep=x.group(1), ttfb=int(x.group(3)),
                         status=int(x.group(4)), pay=int(x.group(5)), acc=x.group(7)))
print(f"upstream attempts: {len(perf)}")
print("status mix:", Counter(p["status"] for p in perf).most_common())
if perf:
    print("payload: min=%.2fMB p50=%.2fMB max=%.2fMB" % (
        min(p['pay'] for p in perf)/1e6,
        st.median([p['pay'] for p in perf])/1e6,
        max(p['pay'] for p in perf)/1e6))

print("\n=== ALL non-INFO messages in window (errors/warns = the 503 story) ===")
for r in win:
    if r.get("level") in ("ERROR", "WARN"):
        print(f"  {r['timestamp'][11:19]} [{r['level']:5s}] {r.get('category','')}: {(r.get('message') or '')[:230]}")

print("\n=== message shapes containing 503/500/timeout/abort/stall ===")
pat = re.compile(r"503|\b500\b|timeout|timed out|abort|stall|watchdog|ECONN|socket|EPIPE|premature", re.I)
c = Counter()
for r in win:
    m = r.get("message", "") or ""
    if pat.search(m):
        c[re.sub(r"\d+", "N", m)[:150]] += 1
for k, v in c.most_common(30):
    print(f"  {v:4d}x  {k}")

print("\n=== 429 vs other failures in this window ===")
c2 = Counter()
for r in win:
    m = r.get("message", "") or ""
    if "rate-limited, backoff" in m: c2["429 retry"] += 1
    if "recovered from 429" in m: c2["429 recovered"] += 1
    if "still rate-limited after" in m: c2["429 exhausted"] += 1
    if "Context overflow recovery" in m: c2["ctx overflow"] += 1
    if "All endpoints" in m or "all endpoints" in m: c2["all endpoints failed"] += 1
print(" ", dict(c2))

print("\n=== TTFB of successful 200s in this window (the 97s/123s/200s cases) ===")
t200 = sorted(p["ttfb"] for p in perf if p["status"] == 200)
if t200:
    n = len(t200)
    print(f"  n={n} p50={t200[n//2]}ms p90={t200[int(n*0.9)]}ms max={t200[-1]}ms")
    print(f"  attempts with TTFB > 30s: {sum(1 for t in t200 if t > 30000)}")

print("\n=== STREAM-END events (did streams complete or get cut?) ===")
se = [r for r in win if r.get("category") == "STREAM-END"]
print(f"  count={len(se)}")
for r in se[:12]:
    print(f"   {r['timestamp'][11:19]} {(r.get('message') or '')[:200]}")
