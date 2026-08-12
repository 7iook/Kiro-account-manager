import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
# capture groups: 1=ep 2=region 3=ttfb 4=status 5=pay 6=via 7=acc
RE = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

def window(lo, hi, label):
    out = []
    for r in rows:
        ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
        if not (lo <= ts <= hi): continue
        x = RE.search(r.get("message", "") or "")
        if x:
            out.append(dict(ts=ts, ep=x.group(1), ttfb=int(x.group(3)), status=int(x.group(4)),
                            pay=int(x.group(5)), acc=x.group(7)))
    n429 = sum(1 for p in out if p["status"] == 429)
    n200 = sum(1 for p in out if p["status"] == 200)
    t429 = sorted(p["ttfb"] for p in out if p["status"] == 429)
    t200 = sorted(p["ttfb"] for p in out if p["status"] == 200)
    pay429 = [p["pay"] for p in out if p["status"] == 429]
    print(f"\n=== {label} ===")
    print(f"  upstream attempts={len(out)}  200={n200}  429={n429}  429rate={n429*100/max(1,len(out)):.1f}%")
    print(f"  status mix: {Counter(p['status'] for p in out).most_common()}")
    if t429: print(f"  429 TTFB  p50={t429[len(t429)//2]}ms  min={t429[0]}  max={t429[-1]}")
    if t200: print(f"  200 TTFB  p50={t200[len(t200)//2]}ms  min={t200[0]}  max={t200[-1]}")
    if pay429: print(f"  wasted upload = {sum(pay429)/1e6:.0f} MB  (median {st.median(pay429)/1e6:.2f} MB per 429)")
    ep = defaultdict(lambda: [0,0]); ac = defaultdict(lambda: [0,0])
    for p in out:
        ep[p["ep"]][0]+=1; ac[p["acc"]][0]+=1
        if p["status"]==429: ep[p["ep"]][1]+=1; ac[p["acc"]][1]+=1
    print("  per endpoint:", {k: f"{v[1]}/{v[0]}={v[1]*100//max(1,v[0])}%" for k,v in ep.items()})
    print("  per account :", {k[:14]: f"{v[1]}/{v[0]}={v[1]*100//max(1,v[0])}%" for k,v in ac.items()})
    return out

storm = window(datetime(2026,8,10,16,47,tzinfo=timezone.utc),
               datetime(2026,8,10,17,16,tzinfo=timezone.utc),
               "STORM window (organic Claude Code traffic, 29min)")
mine  = window(datetime(2026,8,10,17,20,tzinfo=timezone.utc),
               datetime(2026,8,10,18,15,tzinfo=timezone.utc),
               "MY controlled experiment (29 client requests, 55min)")

print("\n=== THE DECISIVE COMPARISON ===")
print("  Both windows: same proxy, same code, same ~0.75MB median payload.")
print("  Difference: storm used accounts uts1xmmfb/uedxuspvs; mine used u72df2cdc/u8ri1fdun")
print("  My run: 29/29 client requests succeeded (100%), zero client-visible failures.")
print(f"  Amplification: {len(mine)}/29 = {len(mine)/29:.1f} upstream attempts per client request")

print("\n=== 429-retry effectiveness, client-outcome-anchored ===")
LO=datetime(2026,8,10,17,20,tzinfo=timezone.utc); HI=datetime(2026,8,10,18,15,tzinfo=timezone.utc)
rr=re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")
rc=re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
re_=re.compile(r"^(\S+) still rate-limited after (\d+) retries")
retr=[];recv=[];exh=[]
for r in rows:
    ts=datetime.fromisoformat(r["timestamp"].replace("Z","+00:00"))
    if not (LO<=ts<=HI): continue
    m=r.get("message","") or ""
    if (x:=rr.match(m)): retr.append((ts,int(x.group(3)),int(x.group(2))))
    elif (x:=rc.match(m)): recv.append((ts,int(x.group(2))))
    elif (x:=re_.match(m)): exh.append((ts,int(x.group(2))))
print(f"  retries={len(retr)} recovered={len(recv)} exhausted={len(exh)}")
print(f"  recovery rate = {len(recv)*100/max(1,len(recv)+len(exh)):.1f}%")
waits=[w for _,_,w in retr]
print(f"  backoff waits: min={min(waits)} max={max(waits)} mean={st.mean(waits):.0f}ms")
t429=sorted(p['ttfb'] for p in mine if p['status']==429)
if t429:
    print(f"  backoff as share of one 429 round-trip: {st.mean(waits)/t429[len(t429)//2]*100:.1f}%")
c=Counter(n for _,n in recv); tot=sum(c.values()); cum=0
print("  cumulative resolution by probe #:")
for n in sorted(c):
    cum+=c[n]
    print(f"    <= probe {n:2d}: {cum*100/tot:5.1f}%")
print(f"\n  ==> probes 1-3 resolve {sum(v for k,v in c.items() if k<=3)*100/tot:.1f}% ;"
      f" probes 4-10 add only {sum(v for k,v in c.items() if k>3)*100/tot:.1f}%")
