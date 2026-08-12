"""
CORRECTION CHECK: is EU-vs-US 429 asymmetry an actionable choice, or just two
different accounts pinned to their own regions?

getSortedEndpoints() forbids cross-region V1 fallback (RCA 2026-08-03: EU token on
US endpoint => 403, reproduced with 3 real ksk). So an account's endpoint set is
determined by account.region. If each account only ever appears on ONE region's
endpoints, then "prefer the low-429 endpoint" is NOT available per-account --
the only lever is ACCOUNT selection, not endpoint selection.
"""
import json, re
from collections import defaultdict, Counter
from datetime import datetime, timezone

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
RE = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B via=(\w+) acc=(\S+)")

recs = []
for r in rows:
    x = RE.search(r.get("message", "") or "")
    if x:
        recs.append(dict(ts=datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")),
                         ep=x.group(1), region=x.group(2), status=int(x.group(4)),
                         pay=int(x.group(5)), acc=x.group(7)))
print(f"total perf records: {len(recs)}")

print("\n=== which endpoints did each account actually use? ===")
by = defaultdict(Counter)
for r in recs: by[r["acc"]][r["ep"]] += 1
for acc, eps in by.items():
    print(f"  {acc:26s} -> {dict(eps)}")

print("\n=== per (account, endpoint) 429 rate ===")
st = defaultdict(lambda: [0, 0])
for r in recs:
    st[(r["acc"], r["ep"])][0] += 1
    if r["status"] == 429: st[(r["acc"], r["ep"])][1] += 1
for (acc, ep), (n, k) in sorted(st.items(), key=lambda kv: -kv[1][0]):
    print(f"  {acc[:22]:22s} {ep:16s} n={n:4d} 429={k:4d} rate={k*100/n:5.1f}%")

print("\n=== region field per account (decides endpoint set) ===")
for acc, c in defaultdict(Counter, {a: Counter(r["region"] for r in recs if r["acc"] == a)
                                    for a in by}).items():
    print(f"  {acc:26s} regions={dict(c)}")

print("\n=== CRITICAL: did ANY single account use BOTH an EU and a US endpoint? ===")
for acc, eps in by.items():
    has_eu = any("EU" in e or "eu" in e for e in eps)
    has_us = any("US" in e or e in ("CodeWhisperer", "AmazonQ", "AmazonQCLI") for e in eps)
    print(f"  {acc:26s} EU={has_eu} US={has_us} "
          f"{'<== CROSS-REGION, endpoint choice IS available' if has_eu and has_us else '(pinned to one region)'}")

print("\n=== So what IS the actionable lever? account-level 429 comparison ===")
acc_st = defaultdict(lambda: [0, 0])
for r in recs:
    acc_st[r["acc"]][0] += 1
    if r["status"] == 429: acc_st[r["acc"]][1] += 1
rank = sorted(acc_st.items(), key=lambda kv: kv[1][1]/max(1, kv[1][0]))
print("  accounts ranked by 429 rate (best first):")
for acc, (n, k) in rank:
    print(f"    {acc:26s} n={n:4d} 429={k:4d} rate={k*100/n:5.1f}%")
if len(rank) >= 2:
    best, worst = rank[0], rank[-1]
    bn, bk = best[1]; wn, wk = worst[1]
    print(f"\n  best  {best[0]}: {bk*100/bn:.1f}%")
    print(f"  worst {worst[0]}: {wk*100/wn:.1f}%")
    print(f"  => routing toward the healthier ACCOUNT is the real lever, spread = "
          f"{wk*100/wn - bk*100/bn:.1f}pp")

print("\n=== is the healthy/unhealthy split stable over time, or does it drift? ===")
recs.sort(key=lambda r: r["ts"])
if recs:
    t0 = recs[0]["ts"]
    for acc in by:
        s = [r for r in recs if r["acc"] == acc]
        if len(s) < 20: continue
        half = len(s)//2
        for lbl, part in (("first half", s[:half]), ("second half", s[half:])):
            k = sum(1 for r in part if r["status"] == 429)
            print(f"  {acc[:22]:22s} {lbl:12s} n={len(part):4d} 429rate={k*100/len(part):5.1f}%")
