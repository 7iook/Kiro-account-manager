import json, re
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
def t(r): return datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
print(f"rows={len(rows)}  {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")

PAT = re.compile(r"HoldGate|挂起|放行|release|resume|hold|budget|预算|兜底|复查", re.I)
hits = [r for r in rows if PAT.search((r.get("message") or "") + " " + (r.get("category") or ""))]
print(f"hold-related rows: {len(hits)}")

print("\n=== message shapes ===")
for shape, n in Counter(re.sub(r"\d+", "N", (h.get("message") or ""))[:120] for h in hits).most_common(25):
    print(f"  {n:5d}x {shape}")

print("\n=== full chronological hold timeline ===")
for r in hits:
    d = r.get("data")
    extra = ""
    if isinstance(d, dict):
        keep = {k: v for k, v in d.items()
                if k in ("holdReason", "reason", "outcome", "releaseCount", "autoReleaseCount",
                         "heldCount", "budgetMs", "elapsedMs", "waitedMs", "poolSize",
                         "blockedAccounts", "account", "episodeId", "resumed")}
        if keep: extra = "  " + json.dumps(keep, ensure_ascii=False)[:220]
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):10s} "
          f"{(r.get('message') or '')[:130]}{extra}")

print("\n=== auto-release specifics (interval vs actual) ===")
rel = [r for r in hits if re.search(r"放行|release|resume", (r.get("message") or ""), re.I)]
print(f"  release-ish events: {len(rel)}")
prev = None
for r in rel:
    ts = t(r)
    gap = f"  (+{(ts-prev).total_seconds():.0f}s)" if prev else ""
    prev = ts
    print(f"  {ts.strftime('%H:%M:%S')} {(r.get('message') or '')[:110]}{gap}")

print("\n=== what ENDED each hold episode? (look for terminal events) ===")
END = re.compile(r"超时|timeout|abort|budget.*exhaust|预算.*用完|终态|ended|giveup|放弃|客户端.*断|closed", re.I)
for r in rows:
    m = (r.get("message") or "")
    if END.search(m) and re.search(r"hold|挂起|HoldGate", m + (r.get("category") or ""), re.I):
        print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level')}] {m[:170]}")

print("\n=== client-side disconnects / stream errors near holds ===")
DIS = re.compile(r"Stream error|terminated|aborted|ECONNRESET|client.*clos|premature", re.I)
dis = [r for r in rows if DIS.search(r.get("message") or "")]
print(f"  disconnect-ish rows: {len(dis)}")
for r in dis[-25:]:
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {(r.get('message') or '')[:150]}")
