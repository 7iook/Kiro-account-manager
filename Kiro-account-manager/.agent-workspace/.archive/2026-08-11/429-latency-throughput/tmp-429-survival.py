import json, re, statistics as st
from collections import defaultdict, Counter
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
re_perf  = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")
re_retry = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")
re_recov = re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
re_exh   = re.compile(r"^(\S+) still rate-limited after (\d+) retries")

ev=[]
for r in rows:
    m=r.get("message","") or ""
    ts=datetime.fromisoformat(r["timestamp"].replace("Z","+00:00"))
    if (x:=re_perf.search(m)):   ev.append(dict(k="perf",ts=ts,ep=x.group(1),ttfb=int(x.group(3)),status=int(x.group(4)),pay=int(x.group(5))))
    elif (x:=re_retry.match(m)): ev.append(dict(k="retry",ts=ts,ep=x.group(1),wait=int(x.group(2)),idx=int(x.group(3))))
    elif (x:=re_recov.match(m)): ev.append(dict(k="recov",ts=ts,ep=x.group(1),n=int(x.group(2))))
    elif (x:=re_exh.match(m)):   ev.append(dict(k="exh",ts=ts,ep=x.group(1),n=int(x.group(2))))
ev.sort(key=lambda e:e["ts"])

# Build episodes: from first 429 (retry idx==1) to terminal (recov / exh)
eps=[]; cur=None
for e in ev:
    if e["k"]=="retry" and e["idx"]==1:
        if cur: eps.append(cur)
        cur=dict(ep=e["ep"], t0=e["ts"], marks=[], term=None)
    if cur is None: continue
    if e["k"]=="retry": cur["marks"].append(((e["ts"]-cur["t0"]).total_seconds(), e["idx"]))
    elif e["k"]=="recov":
        cur["term"]=("recovered",(e["ts"]-cur["t0"]).total_seconds(),e["n"]); eps.append(cur); cur=None
    elif e["k"]=="exh":
        cur["term"]=("exhausted",(e["ts"]-cur["t0"]).total_seconds(),e["n"]); eps.append(cur); cur=None
if cur: eps.append(cur)

done=[e for e in eps if e["term"]]
rec=[e for e in done if e["term"][0]=="recovered"]
exh=[e for e in done if e["term"][0]=="exhausted"]
print(f"=== episodes ===\n  total={len(eps)} terminated={len(done)} recovered={len(rec)} exhausted={len(exh)}")
print(f"  overall recovery rate within 10 retries: {len(rec)*100/max(1,len(done)):.1f}%")

print("\n=== SURVIVAL: elapsed time since first 429 when success finally happened ===")
d=sorted(e["term"][1] for e in rec); n=len(d)
if n:
    for q,l in [(.1,"p10"),(.25,"p25"),(.5,"p50"),(.75,"p75"),(.9,"p90")]:
        print(f"  {l}: {d[min(n-1,int(n*q))]:7.2f}s")
    print(f"  max: {d[-1]:.2f}s")
print("\n  cumulative recovery probability by elapsed wall-time:")
tot=len(done)
for t in (0.5,1,2,3,5,8,12,20,30,60,120):
    got=sum(1 for e in rec if e["term"][1]<=t)
    print(f"    within {t:6.1f}s : {got:3d}/{tot}  = {got*100/tot:5.1f}% of all 429 episodes resolved")

print("\n=== how long did an exhausted episode burn before giving up? ===")
d=sorted(e["term"][1] for e in exh); n=len(d)
if n:
    print(f"  n={n} p50={d[n//2]:.2f}s p90={d[int(n*.9)]:.2f}s max={d[-1]:.2f}s")
    print(f"  total wall-time burned by exhausted episodes: {sum(d):.0f}s")

print("\n=== marginal value of each retry attempt (recovered at attempt k) ===")
c=Counter(e["term"][2] for e in rec)
tot=len(done); cum=0
for k in sorted(c):
    cum+=c[k]
    print(f"  attempt {k:2d}: {c[k]:3d} successes  | cumulative resolved {cum*100/tot:5.1f}% of episodes")
print(f"  never resolved (exhausted -> endpoint fallback): {len(exh)*100/tot:5.1f}%")

print("\n=== per-endpoint recovery ===")
for ep in set(e["ep"] for e in done):
    s=[e for e in done if e["ep"]==ep]
    r=[e for e in s if e["term"][0]=="recovered"]
    print(f"  {ep:16s} episodes={len(s):3d} recovered={len(r):3d} ({len(r)*100/len(s):5.1f}%)")

print("\n=== BURST STRUCTURE: are 429 episodes clustered in time? ===")
t=[e["t0"] for e in eps]
gaps=[(t[i+1]-t[i]).total_seconds() for i in range(len(t)-1)]
if gaps:
    g=sorted(gaps); n=len(g)
    print(f"  gap between episodes: p50={g[n//2]:.1f}s p90={g[int(n*.9)]:.1f}s")
    print(f"  episodes starting <15s after previous (clustered): {sum(1 for x in gaps if x<15)}/{len(gaps)}")

# Was the FIRST request of an episode preceded by a recent success? (self-inflicted test)
print("\n=== SELF-INFLICTED TEST: 429-episode onset vs recent own traffic ===")
perf=[e for e in ev if e["k"]=="perf"]
def prior(ts, sec):
    return sum(1 for p in perf if 0 < ts.timestamp()-p["ts"].timestamp() <= sec)
on=[prior(e["t0"],30) for e in eps]
print(f"  own requests in prior 30s at episode onset: median={st.median(on):.1f} mean={st.mean(on):.2f} max={max(on)}")
zero=sum(1 for x in on if x==0)
print(f"  episodes that began with ZERO own traffic in prior 30s: {zero}/{len(on)} = {zero*100/len(on):.1f}%")
print("  -> if this share is large, the limiter is NOT driven by our own recent rate")
