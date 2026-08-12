import json, re, statistics as st
from collections import Counter
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
re_perf = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

# my experiment window: 2026-08-11 01:26 -> 02:09 local (UTC+8) == 17:26 -> 18:09 UTC on 08-10
LO = datetime(2026, 8, 10, 17, 20, tzinfo=timezone.utc)
HI = datetime(2026, 8, 10, 18, 15, tzinfo=timezone.utc)

mine = []
for r in rows:
    ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
    if not (LO <= ts <= HI): continue
    mine.append((ts, r.get("level"), r.get("category"), r.get("message", "")))

print(f"rows inside my experiment window: {len(mine)}")

perf = []
for ts, lv, cat, m in mine:
    x = re_perf.search(m)
    if x:
        perf.append(dict(ts=ts, ep=x.group(1), ttfb=int(x.group(3)), status=int(x.group(4)),
                         pay=int(x.group(5)), acc=x.group(7)))

print(f"\n=== MY experiment: upstream attempts seen by proxy ===")
print(f"  perf lines: {len(perf)}")
print("  status mix:", Counter(p['status'] for p in perf).most_common())
print("  endpoints :", Counter(p['ep'] for p in perf).most_common())
print("  accounts  :", Counter(p['acc'] for p in perf).most_common())
r429 = [p for p in perf if p["status"] == 429]
print(f"  429 count: {len(r429)}  ({len(r429)*100/max(1,len(perf)):.1f}%)")

print(f"\n=== retry/recover events in MY window ===")
c = Counter()
for ts, lv, cat, m in mine:
    if "rate-limited, backoff" in m: c["429 retry"] += 1
    if "recovered from 429" in m: c["recovered"] += 1
    if "still rate-limited after" in m: c["exhausted"] += 1
    if "Context overflow recovery" in m: c["ctx overflow recovery"] += 1
    if "status=400" in m: c["400"] += 1
print("  ", dict(c))

print(f"\n=== TTFB by payload bucket (MY clean run, no 429 contamination) ===")
for lo, hi in [(0, .3), (.3, .8), (.8, 1.6), (1.6, 99)]:
    s = [p for p in perf if lo*1e6 <= p["pay"] < hi*1e6 and p["status"] == 200]
    if not s: continue
    t = sorted(p["ttfb"] for p in s)
    pay = st.median([p["pay"] for p in s])
    print(f"  {lo:4.1f}-{hi:4.1f}MB  n={len(s):3d}  pay_med={pay/1e6:5.2f}MB  "
          f"TTFB p50={t[len(t)//2]:6d}ms  min={t[0]:6d}  max={t[-1]:6d}  "
          f"upload_rate={pay/t[len(t)//2]/1000:5.2f}MB/s")

print(f"\n=== SANITY: compare yesterday's 429 storm window vs my clean window ===")
S_LO = datetime(2026, 8, 10, 16, 47, tzinfo=timezone.utc)
S_HI = datetime(2026, 8, 10, 17, 16, tzinfo=timezone.utc)
storm = []
for r in rows:
    ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
    if S_LO <= ts <= S_HI:
        x = re_perf.search(r.get("message", ""))
        if x: storm.append(dict(status=int(x.group(4)), acc=x.group(7), pay=int(x.group(5))))
print(f"  storm window   n={len(storm):4d}  429={sum(1 for p in storm if p['status']==429):4d}"
      f"  rate={sum(1 for p in storm if p['status']==429)*100/max(1,len(storm)):5.1f}%")
print(f"  my window      n={len(perf):4d}  429={len(r429):4d}"
      f"  rate={len(r429)*100/max(1,len(perf)):5.1f}%")
print(f"  storm accounts: {Counter(p['acc'] for p in storm).most_common()}")
print(f"  my accounts   : {Counter(p['acc'] for p in perf).most_common()}")
print(f"  storm payload med: {st.median([p['pay'] for p in storm])/1e6:.2f}MB" if storm else "")
print(f"  my payload med   : {st.median([p['pay'] for p in perf])/1e6:.2f}MB" if perf else "")
