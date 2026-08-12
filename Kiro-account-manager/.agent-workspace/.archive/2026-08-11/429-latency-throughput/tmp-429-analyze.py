import json, re, sys
from collections import Counter, defaultdict
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
print(f"total log rows: {len(rows)}  span {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")

re_retry = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+) \(strategy=(\w+)\)")
re_recov = re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
re_exh   = re.compile(r"^(\S+) still rate-limited after (\d+) retries")
re_perf  = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

retries, recov, exh, perf = [], [], [], []
for r in rows:
    m = r.get("message", "") or ""
    ts = r.get("timestamp")
    if (x := re_retry.match(m)):
        retries.append((ts, x.group(1), int(x.group(2)), int(x.group(3)), int(x.group(4)), x.group(5)))
    elif (x := re_recov.match(m)):
        recov.append((ts, x.group(1), int(x.group(2))))
    elif (x := re_exh.match(m)):
        exh.append((ts, x.group(1), int(x.group(2))))
    elif (x := re_perf.search(m)):
        perf.append((ts, x.group(1), x.group(2), int(x.group(3)), int(x.group(4)), int(x.group(5)), x.group(6), x.group(7)))

print(f"\n=== volume ===\nretry events: {len(retries)}   recovered: {len(recov)}   exhausted: {len(exh)}   perf lines: {len(perf)}")

print("\n=== recovered after N retries (N = how many 429s before success) ===")
c = Counter(n for _, _, n in recov)
tot = sum(c.values())
cum = 0
for n in sorted(c):
    cum += c[n]
    print(f"  after {n:2d} retries: {c[n]:4d}  ({c[n]*100/tot:5.1f}%)  cum {cum*100/tot:5.1f}%")

print("\n=== per endpoint ===")
for ep, cnt in Counter(ep for _, ep, _, _, _, _ in retries).items():
    print(f"  {ep}: {cnt} retry-events")
for ep, cnt in Counter(ep for _, ep, _ in recov).items():
    print(f"  {ep}: {cnt} recoveries")

print("\n=== backoff waits actually used ===")
print(sorted(Counter(w for _, _, w, _, _, _ in retries).items())[:20])

print("\n=== retry attempt index distribution (which attempt number) ===")
for k, v in sorted(Counter(i for _, _, _, i, _, _ in retries).items()):
    print(f"  attempt {k}: {v}")

print("\n=== perf: TTFB by status ===")
by = defaultdict(list)
for ts, ep, reg, ttfb, st, pay, via, acc in perf:
    by[(ep, st)].append(ttfb)
for k in sorted(by):
    v = sorted(by[k])
    n = len(v)
    print(f"  {k[0]:16s} status={k[1]}  n={n:4d} p50={v[n//2]:6d} p95={v[min(n-1,int(n*0.95))]:7d} max={v[-1]:7d}")

print("\n=== payload sizes seen in perf lines ===")
pays = sorted(p for *_, p, _, _ in [(t,e,r,tt,s,p,v,a) for t,e,r,tt,s,p,v,a in perf])
if pays:
    n=len(pays)
    print(f"  n={n} min={pays[0]} p50={pays[n//2]} p95={pays[min(n-1,int(n*0.95))]} max={pays[-1]}")

print("\n=== 429 clustering: gaps between consecutive retry events (seconds) ===")
def pt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
tss = [pt(t) for t, *_ in retries]
gaps = [(tss[i+1]-tss[i]).total_seconds() for i in range(len(tss)-1)]
if gaps:
    gs = sorted(gaps)
    n = len(gs)
    print(f"  n={n} p50={gs[n//2]:.2f}s p90={gs[int(n*0.9)]:.2f}s max={gs[-1]:.2f}s")
    print(f"  gaps > 5s (burst boundaries): {sum(1 for g in gaps if g > 5)}")

print("\n=== 429 rate per minute (burst shape) ===")
mins = Counter(t[:16] for t, *_ in retries)
for m in sorted(mins)[:100]:
    print(f"  {m}  {'#'*min(mins[m],60)} {mins[m]}")
