"""
Does prompt-cache hit rate explain the slow first response? And does history
trimming destroy the cache?

Two data sources:
  A) proxy-request-logs.json  -> client-visible: inputTokens, cacheReadTokens, responseTime
  B) proxy-logs.json          -> upstream: TTFB per attempt, plus trim/overflow events

Hypotheses:
  H1 cache hit ratio inversely correlates with latency (per unit of input)
  H2 requests that triggered trimming have systematically worse cache hits
  H3 uncached tokens (input - cacheRead) predicts latency better than raw input
"""
import json, re, statistics as st
from collections import defaultdict, Counter
from datetime import datetime, timezone

RQ = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-request-logs.json"
LG = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
reqs = json.load(open(RQ, encoding="utf-8"))
rows = json.load(open(LG, encoding="utf-8"))
print(f"client requests: {len(reqs)}   log rows: {len(rows)}")

ok = [r for r in reqs if r.get("status") == 200 and r.get("inputTokens") and r.get("responseTime")]
print(f"successful requests with tokens+latency: {len(ok)}")

def pearson(xs, ys):
    if len(xs) < 3: return float("nan")
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((a-mx)*(b-my) for a, b in zip(xs, ys))
    den = (sum((a-mx)**2 for a in xs) * sum((b-my)**2 for b in ys)) ** 0.5
    return num/den if den else float("nan")

print("\n=== H1: cache hit ratio vs latency ===")
for r in ok:
    r["_cache"] = r.get("cacheReadTokens") or 0
    r["_ratio"] = r["_cache"] / r["inputTokens"] if r["inputTokens"] else 0
    r["_uncached"] = max(0, r["inputTokens"] - r["_cache"])
buckets = [(0, 0.001, "no cache (0%)"), (0.001, 0.3, "1-30%"),
           (0.3, 0.6, "30-60%"), (0.6, 0.9, "60-90%"), (0.9, 9, ">90%")]
for lo, hi, label in buckets:
    s = [r for r in ok if lo <= r["_ratio"] < hi]
    if not s: continue
    lat = sorted(r["responseTime"]/1000 for r in s)
    inp = st.median([r["inputTokens"] for r in s])
    print(f"  {label:15s} n={len(s):3d}  input_med={inp/1000:6.0f}k tok  "
          f"latency p50={lat[len(lat)//2]:6.1f}s  p90={lat[int(len(lat)*0.9)]:6.1f}s  max={lat[-1]:6.1f}s")

print("\n=== H3: which predicts latency better — raw input, or UNCACHED tokens? ===")
lat = [r["responseTime"] for r in ok]
print(f"  r(inputTokens,   latency) = {pearson([r['inputTokens'] for r in ok], lat):+.3f}")
print(f"  r(uncachedToks,  latency) = {pearson([r['_uncached'] for r in ok], lat):+.3f}")
print(f"  r(cacheRatio,    latency) = {pearson([r['_ratio'] for r in ok], lat):+.3f}")
print("  (higher |r| on uncached -> prefill of NON-cached tokens is the cost driver)")

print("\n=== latency per 100k tokens: cached vs uncached view ===")
for lo, hi, label in buckets:
    s = [r for r in ok if lo <= r["_ratio"] < hi]
    if len(s) < 3: continue
    per_raw = st.median([r["responseTime"]/1000 / (r["inputTokens"]/1e5) for r in s])
    unc = [r for r in s if r["_uncached"] > 0]
    per_unc = st.median([r["responseTime"]/1000 / (r["_uncached"]/1e5) for r in unc]) if unc else float("nan")
    print(f"  {label:15s} {per_raw:5.2f}s per 100k RAW input   |  {per_unc:6.2f}s per 100k UNCACHED")

print("\n=== same-size comparison: 130-180k token requests, split by cache ===")
band = [r for r in ok if 130_000 <= r["inputTokens"] <= 180_000]
hit = [r for r in band if r["_ratio"] > 0.3]
miss = [r for r in band if r["_ratio"] <= 0.001]
for label, s in (("cache >30%", hit), ("cache 0%", miss)):
    if not s: continue
    lat = sorted(r["responseTime"]/1000 for r in s)
    print(f"  {label:12s} n={len(s):3d}  latency p50={lat[len(lat)//2]:6.1f}s  "
          f"mean={st.mean(lat):6.1f}s  max={lat[-1]:6.1f}s")
if hit and miss:
    h = st.median([r["responseTime"] for r in hit]); m = st.median([r["responseTime"] for r in miss])
    print(f"  ==> zero-cache requests are {m/h:.2f}x slower at the SAME input size")

print("\n=== H2: does history trimming coincide with cache loss? ===")
trim_pat = re.compile(r"(Context overflow recovery|trimHistory|dropped \d+ oldest|裁剪)", re.I)
trims = []
for r in rows:
    m = r.get("message", "") or ""
    if trim_pat.search(m):
        trims.append((datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")), m[:150]))
print(f"  trim/overflow events in log: {len(trims)}")
for t, m in trims[:5]:
    print(f"    {t.strftime('%H:%M:%S')} {m}")

# cache-write vs cache-read: a write means the prefix was NEW (cache was invalidated)
print("\n=== cache write/read events from upstream log (prefix stability) ===")
cw = Counter()
for r in rows:
    m = r.get("message", "") or ""
    for k in ("cacheReadTokens", "cacheWriteTokens", "cacheCreation"):
        if k in m: cw[k] += 1
print(f"  {dict(cw)}")

print("\n=== distribution of cache ratio across all successful requests ===")
ratios = sorted(r["_ratio"] for r in ok)
n = len(ratios)
if n:
    print(f"  p10={ratios[int(n*.1)]:.2f} p25={ratios[int(n*.25)]:.2f} p50={ratios[n//2]:.2f} "
          f"p75={ratios[int(n*.75)]:.2f} p90={ratios[int(n*.9)]:.2f}")
    zero = sum(1 for x in ratios if x < 0.001)
    print(f"  requests with ZERO cache hit: {zero}/{n} = {zero*100/n:.0f}%  <-- each pays full prefill")
