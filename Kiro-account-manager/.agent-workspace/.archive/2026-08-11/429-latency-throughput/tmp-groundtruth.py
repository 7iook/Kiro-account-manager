"""
Final controlled analysis on MY OWN experiment window, where I know the ground truth:
29 client requests, all returned 200 to the client.
The proxy internally saw 205 upstream attempts, 55 of them 429.

This lets me compute what NO observational window could: the true end-to-end value
of the retry loop, with client-side outcome known.
"""
import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
LO = datetime(2026, 8, 10, 17, 20, tzinfo=timezone.utc)
HI = datetime(2026, 8, 10, 18, 15, tzinfo=timezone.utc)

re_perf  = re.compile(r"ep=(\S+) region=\S+ TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=\w+ acc=(\S+)")
re_retry = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")
re_recov = re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
re_exh   = re.compile(r"^(\S+) still rate-limited after (\d+) retries")

ev = []
for r in rows:
    ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
    if not (LO <= ts <= HI): continue
    m = r.get("message", "") or ""
    if (x := re_perf.search(m)):
        ev.append(("perf", ts, x.group(1), int(x.group(3)), int(x.group(4)), x.group(5), int(x.group(2))))
    elif (x := re_retry.match(m)):
        ev.append(("retry", ts, x.group(1), int(x.group(3)), int(x.group(2)), None, None))
    elif (x := re_recov.match(m)):
        ev.append(("recov", ts, x.group(1), int(x.group(2)), None, None, None))
    elif (x := re_exh.match(m)):
        ev.append(("exh", ts, x.group(1), int(x.group(2)), None, None, None))
ev.sort(key=lambda e: e[1])

print("=== GROUND TRUTH (my experiment) ===")
print("  client-visible requests: 29   client-visible failures: 0   client success rate: 100%")
perf = [e for e in ev if e[0] == "perf"]
print(f"  upstream attempts: {len(perf)}   429s absorbed internally: {sum(1 for e in perf if e[4]==429)}")
print(f"  => amplification factor: {len(perf)/29:.1f} upstream attempts per client request")

print("\n=== retry loop outcome in MY window ===")
rec = [e for e in ev if e[0] == "recov"]
exh = [e for e in ev if e[0] == "exh"]
print(f"  episodes recovered: {len(rec)}   exhausted: {len(exh)}")
print(f"  recovery rate: {len(rec)*100/max(1,len(rec)+len(exh)):.1f}%  <-- vs 74.1% in the storm window")
c = Counter(e[3] for e in rec)
tot = sum(c.values()); cum = 0
print("  recovered at attempt N:")
for n in sorted(c):
    cum += c[n]
    print(f"    attempt {n:2d}: {c[n]:3d}   cumulative {cum*100/tot:5.1f}%")

print("\n=== hazard by attempt index (MY window — independent replication) ===")
att = Counter(e[3] for e in ev if e[0] == "retry")
for i in sorted(att):
    nxt = att.get(i+1, 0)
    print(f"  probe #{i:2d} reached {att[i]:3d}  -> proceeded to next: {nxt:3d}  "
          f"success at this probe: {(1-nxt/att[i])*100 if att[i] else 0:5.1f}%")

print("\n=== 429 cost in MY window ===")
t429 = [e[6] for e in perf if e[4] == 429]
t200 = [e[6] for e in perf if e[4] == 200]
if t429 and t200:
    print(f"  429 TTFB median: {st.median(t429):.0f}ms   200 TTFB median: {st.median(t200):.0f}ms")
    waits = [e[4] for e in ev if e[0] == "retry"]
    print(f"  backoff waits: min={min(waits)} max={max(waits)} mean={st.mean(waits):.0f}ms")
    print(f"  backoff share of one 429 round-trip: {st.mean(waits)/st.median(t429)*100:.1f}%")
    wasted_bytes = sum(e[5] and 0 or 0 for e in perf)
    pay429 = [int(e[5]) if isinstance(e[5], int) else 0 for e in perf if e[4] == 429]

pay429 = []
for r in rows:
    ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
    if not (LO <= ts <= HI): continue
    x = re_perf.search(r.get("message", "") or "")
    if x and int(x.group(3)) == 429: pay429.append(int(x.group(4)))
if pay429:
    print(f"  bytes uploaded then rejected: {sum(pay429)/1e6:.0f} MB over 29 client requests")
    print(f"  => {sum(pay429)/1e6/29:.2f} MB wasted upload per client request")

print("\n=== endpoint / account rotation actually exercised ===")
print("  attempts per endpoint:", Counter(e[2] for e in perf).most_common())
print("  attempts per account :", Counter(e[5] for e in perf if e[5]).most_common())
by = defaultdict(lambda: [0, 0])
for e in perf:
    if not e[5]: continue
    by[e[5]][0] += 1
    if e[4] == 429: by[e[5]][1] += 1
for a, (n, k) in by.items():
    print(f"    {a:26s} n={n:3d} 429={k:3d} rate={k*100/n:5.1f}%")
ep = defaultdict(lambda: [0, 0])
for e in perf:
    ep[e[2]][0] += 1
    if e[4] == 429: ep[e[2]][1] += 1
for a, (n, k) in ep.items():
    print(f"    {a:20s} n={n:3d} 429={k:3d} rate={k*100/n:5.1f}%")
