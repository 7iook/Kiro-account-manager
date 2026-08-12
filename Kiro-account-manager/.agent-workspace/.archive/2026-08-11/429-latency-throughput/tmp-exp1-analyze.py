"""
Analyse the maxAttempts=1 experiment window against the proxy's own upstream log.
Local 06:06 -> now  == UTC 22:06 (prev day) onward. Detect actual offset from data.
"""
import json, re, statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
print(f"log rows={len(rows)}  first={rows[0]['timestamp']}  last={rows[-1]['timestamp']}")

RE = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")
RR = re.compile(r"^(\S+) 429 rate-limited, backoff (\d+)ms retry (\d+)/(\d+)")
RC = re.compile(r"^(\S+) recovered from 429 after (\d+) retries")
RX = re.compile(r"^(\S+) still rate-limited after (\d+) retries")

# my exp payload sizes (bytes, approx): 98k, 295k, 590k, 984k, 1476k, 1968k
EXP_PAYS = [98_000, 295_000, 590_000, 984_000, 1_476_000, 1_968_000]
def near(p):
    for e in EXP_PAYS:
        if abs(p - e) / e < 0.06: return e
    return None

perf = []
for r in rows:
    x = RE.search(r.get("message", "") or "")
    if x:
        perf.append(dict(ts=datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")),
                         ep=x.group(1), ttfb=int(x.group(3)), status=int(x.group(4)),
                         pay=int(x.group(5)), acc=x.group(7)))
perf.sort(key=lambda p: p["ts"])
print(f"perf attempts in log: {len(perf)}  window {perf[0]['ts']} -> {perf[-1]['ts']}")

# Find the experiment: contiguous run where payloads match my ladder
tagged = [p for p in perf if near(p["pay"])]
print(f"attempts whose payload matches my ladder: {len(tagged)}")
if tagged:
    print(f"  their time span: {tagged[0]['ts']} -> {tagged[-1]['ts']}")

# take the LAST such contiguous block (this experiment)
if tagged:
    block = [tagged[-1]]
    for p in reversed(tagged[:-1]):
        if (block[0]["ts"] - p["ts"]).total_seconds() < 240:
            block.insert(0, p)
        else:
            break
    print(f"\n=== EXPERIMENT BLOCK (maxAttempts=1) ===")
    print(f"  attempts={len(block)}  span {block[0]['ts'].strftime('%H:%M:%S')} -> {block[-1]['ts'].strftime('%H:%M:%S')}")
    print(f"  status mix: {Counter(p['status'] for p in block).most_common()}")
    print(f"  endpoints : {Counter(p['ep'] for p in block).most_common()}")
    print(f"  accounts  : {Counter(p['acc'] for p in block).most_common()}")

    print("\n  === PER-REQUEST 429 rate by payload (maxAttempts=1: 1 attempt/endpoint) ===")
    g = defaultdict(lambda: [0, 0, []])
    for p in block:
        k = near(p["pay"])
        g[k][0] += 1
        if p["status"] == 429: g[k][1] += 1
        if p["status"] == 200: g[k][2].append(p["ttfb"])
    for k in sorted(g):
        n, k429, t = g[k]
        tok = int(k / 3.0 / 1000)
        print(f"    pay~{k/1e6:4.2f}MB (~{tok*1:4d}k tok)  attempts={n:3d}  429={k429:3d}  "
              f"rate={k429*100/n:5.1f}%  200_TTFB_med={st.median(t) if t else 0:6.0f}ms")

    # how many retry markers appear inside the block (should be ~0 with maxAttempts=1)
    lo, hi = block[0]["ts"], block[-1]["ts"]
    c = Counter()
    for r in rows:
        ts = datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
        if not (lo <= ts <= hi): continue
        m = r.get("message", "") or ""
        if RR.match(m): c["429 retry marker"] += 1
        if RC.match(m): c["recovered"] += 1
        if RX.match(m): c["exhausted->next endpoint"] += 1
        if "Context overflow" in m: c["ctx overflow"] += 1
    print(f"\n  retry markers inside block: {dict(c)}")
    print("  (with maxAttempts=1 the in-endpoint loop should fire at most 1x per endpoint)")

    print("\n  === attempts consumed per client request ===")
    # group consecutive same-payload attempts = one client request
    chains = []
    cur = None
    for p in block:
        if cur and p["pay"] == cur["pay"] and (p["ts"] - cur["t1"]).total_seconds() < 90:
            cur["n"] += 1; cur["t1"] = p["ts"]; cur["eps"].add(p["ep"]); cur["last"] = p["status"]
        else:
            if cur: chains.append(cur)
            cur = dict(pay=p["pay"], n=1, t0=p["ts"], t1=p["ts"], eps={p["ep"]}, last=p["status"])
    if cur: chains.append(cur)
    print(f"    client requests reconstructed: {len(chains)}")
    for c2 in chains:
        print(f"      pay={c2['pay']/1e6:5.2f}MB attempts={c2['n']:2d} "
              f"eps={sorted(c2['eps'])} final={c2['last']} "
              f"wall={(c2['t1']-c2['t0']).total_seconds():5.1f}s "
              f"upload={c2['n']*c2['pay']/1e6:5.1f}MB")
