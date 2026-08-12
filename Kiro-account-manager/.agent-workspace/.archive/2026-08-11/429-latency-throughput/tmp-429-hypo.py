import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
re_perf = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

perf = []
for r in rows:
    m = r.get("message", "") or ""
    x = re_perf.search(m)
    if x:
        perf.append(dict(ts=datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")),
                         ep=x.group(1), ttfb=int(x.group(3)), status=int(x.group(4)),
                         pay=int(x.group(5)), acc=x.group(7)))

print(f"perf samples: {len(perf)}")

# H1: 429 is returned only AFTER full payload upload -> TTFB should scale with payload size
print("\n=== H1  TTFB vs payload size, split by status (upload-bound test) ===")
for status in (429, 200, 400):
    s = [p for p in perf if p["status"] == status]
    if len(s) < 8: continue
    s.sort(key=lambda p: p["pay"])
    q = max(1, len(s) // 4)
    print(f"\n status={status}  n={len(s)}")
    for i, name in enumerate(["Q1 smallest", "Q2", "Q3", "Q4 largest"]):
        chunk = s[i*q:(i+1)*q] if i < 3 else s[3*q:]
        if not chunk: continue
        pays = [c["pay"] for c in chunk]; tt = [c["ttfb"] for c in chunk]
        print(f"   {name:12s} pay median={st.median(pays)/1e6:5.2f}MB  TTFB median={st.median(tt):6.0f}ms  "
              f"implied throughput={st.median(pays)/st.median(tt)/1000:5.2f} MB/s")
    # correlation
    xs=[c["pay"] for c in s]; ys=[c["ttfb"] for c in s]
    mx,my=st.mean(xs),st.mean(ys)
    num=sum((a-mx)*(b-my) for a,b in zip(xs,ys))
    den=(sum((a-mx)**2 for a in xs)*sum((b-my)**2 for b in ys))**0.5
    print(f"   Pearson r(payload, TTFB) = {num/den if den else float('nan'):.3f}")

# H2: does payload size predict 429 probability?
print("\n=== H2  429 probability by payload bucket (is limit token/byte-metered?) ===")
buckets = [(0,.25),(.25,.75),(.75,1.5),(1.5,2.5),(2.5,99)]
for lo,hi in buckets:
    s=[p for p in perf if lo*1e6 <= p["pay"] < hi*1e6]
    if not s: continue
    n429=sum(1 for p in s if p["status"]==429)
    print(f"  {lo:4.2f}-{hi:4.1f}MB  n={len(s):4d}  429={n429:4d}  rate={n429*100/len(s):5.1f}%")

# H3: 429 vs inter-arrival time (is it concurrency / RPM driven?)
print("\n=== H3  429 rate vs gap since previous request (RPM / spacing test) ===")
perf.sort(key=lambda p: p["ts"])
gapped=[]
for i in range(1,len(perf)):
    gapped.append((( perf[i]["ts"]-perf[i-1]["ts"]).total_seconds(), perf[i]["status"]))
for lo,hi,label in [(0,.5,"<0.5s"),(.5,1,"0.5-1s"),(1,2,"1-2s"),(2,5,"2-5s"),(5,15,"5-15s"),(15,1e9,">15s")]:
    s=[g for g in gapped if lo<=g[0]<hi]
    if not s: continue
    n429=sum(1 for g in s if g[1]==429)
    print(f"  gap {label:7s} n={len(s):4d}  429={n429:4d}  rate={n429*100/len(s):5.1f}%")

# H4: in-flight concurrency at moment of each request (approx: requests started within prior TTFB windows)
print("\n=== H4  429 rate vs in-flight concurrency (approx) ===")
def inflight(idx):
    t=perf[idx]["ts"]; c=0
    for j in range(max(0,idx-40), idx):
        if perf[j]["ts"].timestamp()+perf[j]["ttfb"]/1000 > t.timestamp(): c+=1
    return c
by=defaultdict(lambda:[0,0])
for i in range(len(perf)):
    c=min(inflight(i),6)
    by[c][0]+=1
    if perf[i]["status"]==429: by[c][1]+=1
for c in sorted(by):
    n,k=by[c]
    print(f"  in-flight={c}  n={n:4d}  429={k:4d}  rate={k*100/n:5.1f}%")

# H5: is there a sliding-window / recovery-time signature? time from a 429 to next success on same ep
print("\n=== H5  time from 429 to next 200 on same endpoint (window length probe) ===")
per_ep=defaultdict(list)
for p in perf: per_ep[p["ep"]].append(p)
for ep,lst in per_ep.items():
    lst.sort(key=lambda p:p["ts"])
    deltas=[]
    for i,p in enumerate(lst):
        if p["status"]!=429: continue
        for q in lst[i+1:]:
            if q["status"]==200:
                deltas.append((q["ts"]-p["ts"]).total_seconds()); break
    if deltas:
        d=sorted(deltas); n=len(d)
        print(f"  {ep:16s} n={n:4d} p10={d[int(n*.1)]:6.2f}s p50={d[n//2]:6.2f}s p90={d[int(n*.9)]:7.2f}s")

# H6 accounts
print("\n=== H6  per-account 429 (single-account vs single-egress limit) ===")
by=defaultdict(lambda:[0,0])
for p in perf:
    by[p["acc"]][0]+=1
    if p["status"]==429: by[p["acc"]][1]+=1
for a,(n,k) in sorted(by.items(), key=lambda kv:-kv[1][0]):
    print(f"  {a:34s} n={n:4d} 429={k:4d} rate={k*100/n:5.1f}%")
