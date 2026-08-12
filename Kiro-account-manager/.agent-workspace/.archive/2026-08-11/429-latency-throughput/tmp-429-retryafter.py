import json, re
from collections import Counter
P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))

# Did upstream EVER supply Retry-After? Our code caps at min(sec*1000,15000) and logs the wait.
# If Retry-After existed, waits would be >=1000ms. Observed waits were 50-62ms => header absent.
re_retry = re.compile(r"429 rate-limited, backoff (\d+)ms retry")
waits = [int(m.group(1)) for r in rows if (m := re_retry.search(r.get("message","") or ""))]
print(f"=== Retry-After presence test (n={len(waits)} retries) ===")
print(f"  waits observed: min={min(waits)} max={max(waits)}")
big = [w for w in waits if w >= 1000]
print(f"  waits >=1000ms (would indicate Retry-After honored): {len(big)}")
print(f"  -> Retry-After header present in upstream 429: {'YES' if big else 'NO (0/%d)' % len(waits)}")
print(f"  configured baseMs implied by observed waits: ~{round(sum(waits)/len(waits))}ms (jitter +/-25%)")

print("\n=== what config is actually live? ===")
for r in rows:
    if "rateLimitRetryConfig" in (r.get("message","") or ""):
        print("  ", r["timestamp"], r["message"])

print("\n=== endpoint fallback / account switch events ===")
pats = ["trying next endpoint", "next endpoint", "switch", "Switching", "account", "fallback", "All endpoints"]
c = Counter()
for r in rows:
    m = r.get("message","") or ""
    if "still rate-limited after" in m: c["exhausted->next endpoint"] += 1
    if "All endpoints failed" in m or "all endpoints" in m.lower(): c["all endpoints failed"] += 1
    if "Context overflow recovery" in m: c["context overflow recovery"] += 1
    if re.search(r"\b400\b", m) and "status=400" in m: c["status 400"] += 1
for k, v in c.items(): print(f"  {k}: {v}")

print("\n=== level/category mix (what instrumentation exists) ===")
print(" ", Counter(r.get("level") for r in rows).most_common())
print(" ", Counter(r.get("category") for r in rows).most_common(12))

print("\n=== is TTFT (first token) instrumented separately from TTFB? ===")
hits = [r["message"] for r in rows if re.search(r"TTFT|first.?token|firstChunk|first_byte", r.get("message","") or "", re.I)]
print(f"  matches: {len(hits)}")
for h in hits[:5]: print("   ", h[:160])
