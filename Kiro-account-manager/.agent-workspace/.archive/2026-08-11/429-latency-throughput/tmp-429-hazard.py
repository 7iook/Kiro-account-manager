"""
Controlled experiment: does the WAIT LENGTH between 429 retries change the outcome?

Method (offline, no upstream traffic): the log already contains a natural experiment.
Each 429 episode is a sequence of probes at ~53ms spacing. If the limiter window is
time-based (a bucket refilling), then P(success) should depend on ELAPSED TIME since
the first 429, not on the NUMBER of probes. If it were probe-based ("keep knocking
and one will get through"), P(success) per probe would be constant.

We separate the two by binning every probe by its elapsed-time offset and computing
the per-probe hazard rate. A rising hazard vs elapsed time + flat hazard vs probe
index => time-driven window => extra probes are pure waste.
"""
import json, re
from collections import defaultdict
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
re_retry = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")
re_recov = re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
re_exh   = re.compile(r"^(\S+) still rate-limited after (\d+) retries")
re_perf  = re.compile(r"ep=(\S+) region=\S+ TTFB=(\d+)ms status=(\d+) pay=(\d+)B")

ev=[]
for r in rows:
    m=r.get("message","") or ""
    ts=datetime.fromisoformat(r["timestamp"].replace("Z","+00:00"))
    if (x:=re_retry.match(m)):   ev.append(("retry",ts,x.group(1),int(x.group(3)),int(x.group(2))))
    elif (x:=re_recov.match(m)): ev.append(("recov",ts,x.group(1),int(x.group(2)),0))
    elif (x:=re_exh.match(m)):   ev.append(("exh",ts,x.group(1),int(x.group(2)),0))
    elif (x:=re_perf.search(m)): ev.append(("perf",ts,x.group(1),int(x.group(3)),int(x.group(2))))
ev.sort(key=lambda e:e[1])

# probes: (elapsed_since_first_429, probe_index, outcome_success)
probes=[]; cur=None
for kind,ts,ep,a,b in ev:
    if kind=="retry":
        if a==1: cur=dict(t0=ts,ep=ep,idx=[])
        if cur: cur["idx"].append((a,ts))
    elif kind=="recov" and cur:
        for (i,t) in cur["idx"]:
            last = (i==max(x[0] for x in cur["idx"]))
            probes.append(((t-cur["t0"]).total_seconds(), i, last))
        cur=None
    elif kind=="exh" and cur:
        for (i,t) in cur["idx"]:
            probes.append(((t-cur["t0"]).total_seconds(), i, False))
        cur=None

print(f"probes analysed: {len(probes)}")

print("\n=== HAZARD vs ELAPSED TIME since first 429 (time-driven window test) ===")
bins=[(0,.5),(.5,1),(1,2),(2,3),(3,4),(4,6),(6,10),(10,1e9)]
for lo,hi in bins:
    s=[p for p in probes if lo<=p[0]<hi]
    if not s: continue
    ok=sum(1 for p in s if p[2])
    print(f"  elapsed {lo:5.1f}-{hi if hi<1e9 else 99:4.0f}s  probes={len(s):4d}  succeeded={ok:3d}  hazard={ok*100/len(s):5.1f}%")

print("\n=== HAZARD vs PROBE INDEX (probe-driven test) ===")
for i in range(1,11):
    s=[p for p in probes if p[1]==i]
    if not s: continue
    ok=sum(1 for p in s if p[2])
    print(f"  probe #{i:2d}  n={len(s):4d}  succeeded={ok:3d}  hazard={ok*100/len(s):5.1f}%")

print("\n=== COUNTERFACTUAL: budget spent vs recovery achieved ===")
# For each episode reconstruct: probes used, wall time, and what a 1-probe-then-wait-2s policy would give
eps=[]; cur=None
for kind,ts,ep,a,b in ev:
    if kind=="retry" and a==1:
        cur=dict(t0=ts,n=0)
    if cur is None: continue
    if kind=="retry": cur["n"]=a
    elif kind in ("recov","exh"):
        cur["end"]=ts; cur["ok"]=(kind=="recov"); eps.append(cur); cur=None
done=[e for e in eps if "end" in e]
print(f"  episodes={len(done)}")
tot_probes=sum(e['n'] for e in done)
wasted=sum(e['n'] for e in done if not e['ok'])
print(f"  total upstream probes spent on 429 loops: {tot_probes}")
print(f"  probes spent on episodes that NEVER recovered: {wasted} ({wasted*100/tot_probes:.0f}% pure waste)")
succ=[e for e in done if e['ok']]
print(f"  recovered episodes: {len(succ)}  median probes used: {sorted(e['n'] for e in succ)[len(succ)//2]}")
first_try=sum(1 for e in succ if e['n']==1)
print(f"  recovered on the FIRST retry: {first_try}/{len(succ)} = {first_try*100/len(succ):.0f}%")
print(f"  -> probes 2..10 delivered only {len(succ)-first_try} extra successes for {tot_probes-len(done)} extra probes")
eff = (len(succ)-first_try)/max(1,(tot_probes-len(done)))
print(f"  -> marginal yield of probes 2+: {eff*100:.1f}% (each costs ~1.9s upload + full payload re-send)")

print("\n=== UPLOAD AMPLIFICATION (the real cost) ===")
perf=[(a,b) for k,ts,ep,a,b in ev if k=="perf"]
p429=[b for a,b in perf if a==429]
pay429=[]
for r in rows:
    m=r.get("message","") or ""
    x=re_perf.search(m)
    if x and int(x.group(3))==429: pay429.append(int(x.group(4)))
if pay429:
    tot=sum(pay429)
    print(f"  429 responses observed: {len(pay429)}  bytes uploaded then rejected: {tot/1e6:.0f} MB")
    print(f"  median payload re-uploaded per 429: {sorted(pay429)[len(pay429)//2]/1e6:.2f} MB")
    print(f"  => each retry re-uploads the ENTIRE 100k-400k token context to get rejected again")
