import json, re
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
print(f"rows={len(rows)}  {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")

def t(r):
    return datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))

KEY = re.compile(r"HoldGate|not found in pool|quotaExhausted|holdWhenNoAccount|Refuse to fallback|"
                 r"markSuspended|suspended|recordError|quota|no account|No account", re.I)
hits = [r for r in rows if KEY.search(r.get("message", "") or "")]
print(f"\nrelevant rows: {len(hits)}")

print("\n=== distinct message shapes (normalized) ===")
for shape, n in Counter(re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}|\d+\.?\d*", "N", (h.get("message") or ""))[:130]
                        for h in hits).most_common(20):
    print(f"  {n:5d}x {shape}")

print("\n=== chronological trace (last 60 relevant) ===")
for r in hits[-60:]:
    ts = t(r).strftime("%H:%M:%S")
    m = (r.get("message") or "").replace("\n", " ")
    print(f"  {ts} [{r.get('level'):5s}] {r.get('category'):12s} {m[:175]}")

print("\n=== data payloads on HoldGate rows (reason/accountId) ===")
for r in hits:
    if r.get("category") == "HoldGate" and r.get("data"):
        print(f"  {t(r).strftime('%H:%M:%S')} {json.dumps(r['data'], ensure_ascii=False)[:300]}")

print("\n=== pool composition / sync events ===")
POOL = re.compile(r"pool|syncAccounts|同步|setAccounts|updateAccounts|selectedAccountIds", re.I)
pool_rows = [r for r in rows if POOL.search(r.get("message", "") or "")]
print(f"  pool-related rows: {len(pool_rows)}")
for r in pool_rows[-30:]:
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):12s} "
          f"{(r.get('message') or '')[:170]}")
