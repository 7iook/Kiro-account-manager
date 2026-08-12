"""
STATISTICAL CORRECTION: per-REQUEST 429 rate vs payload, not per-ATTEMPT.

My earlier bucket analysis counted attempts: one big request retrying 30x put 30
samples in the bucket, all 429. That structurally destroys any payload signal and
is why I wrongly concluded "payload does not drive 429".

Correct unit = one client request = one episode chain. Reconstruct chains from the
log (a chain starts at retry 1/N or a fresh attempt, ends at 200 / give-up), then
ask: does the FIRST attempt of a request get 429 more often when payload is large?
"""
import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
RE = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")
RR = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")

ev = []
for r in rows:
    ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
    m = r.get("message", "") or ""
    if (x := RE.search(m)):
        ev.append(dict(k="perf", ts=ts, ep=x.group(1), ttfb=int(x.group(3)),
                       status=int(x.group(4)), pay=int(x.group(5)), acc=x.group(7)))
    elif (x := RR.match(m)):
        ev.append(dict(k="retry", ts=ts, ep=x.group(1), idx=int(x.group(3))))
ev.sort(key=lambda e: e["ts"])
perf = [e for e in ev if e["k"] == "perf"]
print(f"total attempts logged: {len(perf)}")

# A "first attempt of a request": a perf line whose payload differs from the
# immediately preceding attempt, OR preceded by no retry marker.
# Retries re-upload the SAME payload, so identical consecutive pay = same request.
firsts = []
prev_pay = None
for i, p in enumerate(perf):
    if prev_pay is None or p["pay"] != prev_pay:
        firsts.append(p)
    prev_pay = p["pay"]
print(f"distinct requests (by payload transition): {len(firsts)}")

print("\n=== CORRECTED: per-REQUEST first-attempt 429 rate vs payload ===")
buckets = [(0, .2, "<0.2MB (~50k tok)"), (.2, .5, "0.2-0.5MB (~50-130k)"),
           (.5, 1.0, "0.5-1.0MB (~130-260k)"), (1.0, 2.0, "1.0-2.0MB (~260-520k)"),
           (2.0, 99, ">2.0MB (~520k+)")]
for lo, hi, label in buckets:
    s = [p for p in firsts if lo*1e6 <= p["pay"] < hi*1e6]
    if not s: continue
    k = sum(1 for p in s if p["status"] == 429)
    print(f"  {label:24s} n={len(s):4d}  429={k:4d}  rate={k*100/len(s):5.1f}%")

print("\n=== compare with the WRONG per-attempt view (what I did before) ===")
for lo, hi, label in buckets:
    s = [p for p in perf if lo*1e6 <= p["pay"] < hi*1e6]
    if not s: continue
    k = sum(1 for p in s if p["status"] == 429)
    print(f"  {label:24s} n={len(s):4d}  429={k:4d}  rate={k*100/len(s):5.1f}%")

print("\n=== total attempts consumed per request, by payload size ===")
# group consecutive identical-payload attempts
chains = []
cur = None
for p in perf:
    if cur and p["pay"] == cur["pay"]:
        cur["n"] += 1
        cur["last"] = p["status"]
        cur["eps"].add(p["ep"])
    else:
        if cur: chains.append(cur)
        cur = dict(pay=p["pay"], n=1, last=p["status"], eps={p["ep"]}, t0=p["ts"])
    cur["t1"] = p["ts"]
if cur: chains.append(cur)
print(f"  chains: {len(chains)}")
for lo, hi, label in buckets:
    s = [c for c in chains if lo*1e6 <= c["pay"] < hi*1e6]
    if not s: continue
    ns = sorted(c["n"] for c in s)
    wall = sorted((c["t1"]-c["t0"]).total_seconds() for c in s)
    reup = st.median([c["n"] * c["pay"] for c in s]) / 1e6
    print(f"  {label:24s} chains={len(s):3d}  attempts p50={ns[len(ns)//2]:2d} max={ns[-1]:3d}  "
          f"wall p50={wall[len(wall)//2]:5.1f}s max={wall[-1]:6.1f}s  "
          f"median re-upload={reup:5.2f}MB  endpoints_used_max={max(len(c['eps']) for c in s)}")

print("\n=== the worst chains (what the user experiences as 200-361s) ===")
worst = sorted(chains, key=lambda c: -c["n"])[:10]
for c in worst:
    print(f"  attempts={c['n']:3d} pay={c['pay']/1e6:5.2f}MB "
          f"wall={(c['t1']-c['t0']).total_seconds():6.1f}s endpoints={sorted(c['eps'])} "
          f"final={c['last']} total_upload={c['n']*c['pay']/1e6:6.1f}MB")

print("\n=== endpoint chain exhaustion: how often did ALL endpoints 429? ===")
multi = [c for c in chains if len(c["eps"]) >= 2]
print(f"  chains touching >=2 endpoints: {len(multi)}/{len(chains)}")
print(f"  chains touching >=3 endpoints: {sum(1 for c in chains if len(c['eps'])>=3)}")
