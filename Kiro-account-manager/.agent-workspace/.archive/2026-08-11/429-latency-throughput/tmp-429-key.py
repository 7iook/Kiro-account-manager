import json, re, statistics as st
from collections import defaultdict, Counter
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
re_perf = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")
re_retry = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")

ev = []
for r in rows:
    m = r.get("message","") or ""
    ts = datetime.fromisoformat(r["timestamp"].replace("Z","+00:00"))
    x = re_perf.search(m)
    if x:
        ev.append(dict(k="perf", ts=ts, ep=x.group(1), ttfb=int(x.group(3)),
                       status=int(x.group(4)), pay=int(x.group(5)), acc=x.group(7)))
        continue
    y = re_retry.match(m)
    if y:
        ev.append(dict(k="retry", ts=ts, ep=y.group(1), wait=int(y.group(2)), idx=int(y.group(3))))
ev.sort(key=lambda e: e["ts"])

# KEY 1: cost of one wasted 429 round-trip
r429=[e["ttfb"] for e in ev if e["k"]=="perf" and e["status"]==429]
r200=[e["ttfb"] for e in ev if e["k"]=="perf" and e["status"]==200]
print("=== KEY1  the real cost structure ===")
print(f"  429 TTFB   n={len(r429)} mean={st.mean(r429):.0f}ms median={st.median(r429):.0f}ms")
print(f"  200 TTFB   n={len(r200)} mean={st.mean(r200):.0f}ms median={st.median(r200):.0f}ms")
print(f"  -> each 429 burns ~{st.median(r429)/1000:.2f}s of upload+RTT; the 50ms backoff is {50/st.median(r429)*100:.1f}% of it")

# KEY 2: reconstruct per-request retry chains from log order
print("\n=== KEY2  reconstructed retry chains (attempts until success) ===")
chains=[]; cur=None
for e in ev:
    if e["k"]=="retry":
        if cur is None or e["idx"]==1:
            if cur: chains.append(cur)
            cur=dict(ep=e["ep"], t0=e["ts"], waits=[e["wait"]], n=1)
        else:
            cur["waits"].append(e["wait"]); cur["n"]+=1
    elif e["k"]=="perf" and e["status"]==200 and cur is not None:
        cur["t_end"]=e["ts"]; cur["ok"]=True; chains.append(cur); cur=None
if cur: chains.append(cur)
ok=[c for c in chains if c.get("ok")]
print(f"  chains: {len(chains)}  ended in success: {len(ok)}")
if ok:
    span=[(c["t_end"]-c["t0"]).total_seconds() for c in ok]
    s=sorted(span); n=len(s)
    waits=[sum(c['waits'])/1000 for c in ok]
    print(f"  wall time lost to 429 loop: p50={s[n//2]:.1f}s p90={s[int(n*.9)]:.1f}s max={s[-1]:.1f}s")
    print(f"  of which pure sleep(backoff): p50={sorted(waits)[len(waits)//2]:.2f}s  <-- sleep is NOT the bottleneck")
    print(f"  retries per successful chain: p50={sorted(c['n'] for c in ok)[len(ok)//2]}")

# KEY 3: does a retry ever succeed immediately? measure success prob per attempt index
print("\n=== KEY3  conditional success probability per attempt (is the window random?) ===")
att=Counter(); 
for e in ev:
    if e["k"]=="retry": att[e["idx"]]+=1
for i in sorted(att):
    nxt=att.get(i+1,0)
    surv=nxt/att[i] if att[i] else 0
    print(f"  attempt {i:2d}: reached {att[i]:4d}  -> still 429 next: {surv*100:5.1f}%   success at this attempt: {(1-surv)*100:5.1f}%")

# KEY 4: global vs per-account: 429 co-occurrence across accounts within same second
print("\n=== KEY4  do different accounts get 429 at the same moment? (global/egress limit test) ===")
buckets=defaultdict(set); b429=defaultdict(set)
for e in ev:
    if e["k"]!="perf": continue
    key=e["ts"].replace(microsecond=0).isoformat()[:19]
    buckets[key].add(e["acc"])
    if e["status"]==429: b429[key].add(e["acc"])
multi=[k for k,v in buckets.items() if len(v)>1]
print(f"  seconds with >=2 distinct accounts active: {len(multi)}")
both=[k for k in multi if len(b429.get(k,()))>1]
print(f"  ... of which >=2 accounts got 429 in that same second: {len(both)}")
for k in both[:10]:
    print(f"    {k}  accounts_429={sorted(b429[k])}")

# KEY 5: 10s-window rate before a 429 (sliding window test)
print("\n=== KEY5  requests in the preceding 10s/60s window, 429 vs 200 ===")
perf=[e for e in ev if e["k"]=="perf"]
def win(i,sec):
    t=perf[i]["ts"].timestamp(); c=0
    for j in range(i-1,-1,-1):
        if t-perf[j]["ts"].timestamp()>sec: break
        c+=1
    return c
for sec in (10,60):
    a=[win(i,sec) for i in range(len(perf)) if perf[i]["status"]==429]
    b=[win(i,sec) for i in range(len(perf)) if perf[i]["status"]==200]
    print(f"  prior-{sec}s count: median before 429={st.median(a):.1f}  before 200={st.median(b):.1f}")

# KEY 6: bytes in flight in preceding 60s (TPM test)
print("\n=== KEY6  bytes uploaded in preceding 60s, 429 vs 200 (TPM test) ===")
def winb(i,sec):
    t=perf[i]["ts"].timestamp(); s=0
    for j in range(i-1,-1,-1):
        if t-perf[j]["ts"].timestamp()>sec: break
        s+=perf[j]["pay"]
    return s
a=[winb(i,60) for i in range(len(perf)) if perf[i]["status"]==429]
b=[winb(i,60) for i in range(len(perf)) if perf[i]["status"]==200]
print(f"  prior-60s bytes: median before 429={st.median(a)/1e6:.2f}MB  before 200={st.median(b)/1e6:.2f}MB")
