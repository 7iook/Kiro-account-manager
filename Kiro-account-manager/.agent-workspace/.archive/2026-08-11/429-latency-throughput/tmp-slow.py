import json, re
from datetime import datetime, timezone, timedelta

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
RQ = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-request-logs.json"
reqs = json.load(open(RQ, encoding="utf-8"))

print("=== client-visible request log: the slow ones ===")
slow = sorted(reqs, key=lambda r: -(r.get("responseTime") or 0))[:14]
for r in slow:
    print(f"  {r['time']}  {r['model']:16s} status={r['status']} "
          f"in={r.get('inputTokens')} out={r.get('outputTokens')} "
          f"cache={r.get('cacheReadTokens')} total={(r.get('responseTime') or 0)/1000:.1f}s")

print("\n=== status distribution in client log ===")
from collections import Counter
print(" ", Counter(r["status"] for r in reqs).most_common())
errs = [r for r in reqs if r["status"] != 200]
print(f"  errors: {len(errs)}/{len(reqs)}")
for r in errs[:20]:
    print(f"   {r['time']} status={r['status']} model={r['model']} "
          f"in={r.get('inputTokens')} total={(r.get('responseTime') or 0)/1000:.1f}s")

print("\n=== correlate: what does a >90s client request look like upstream? ===")
def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))
ev = [(parse(r["timestamp"]), r.get("level"), r.get("category"), (r.get("message") or "")) for r in rows]
ev.sort()

targets = [r for r in reqs if (r.get("responseTime") or 0) > 60000][:6]
for t in targets:
    end = datetime.strptime(t["time"], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc) - timedelta(hours=8)
    start = end - timedelta(milliseconds=t["responseTime"])
    print(f"\n--- client req ending {t['time']} ({t['responseTime']/1000:.1f}s, in={t.get('inputTokens')}, status={t['status']}) ---")
    print(f"    UTC window {start.strftime('%H:%M:%S')} -> {end.strftime('%H:%M:%S')}")
    seen = 0
    for ts, lv, cat, m in ev:
        if start <= ts <= end + timedelta(seconds=2):
            if any(k in m for k in ("TTFB=", "rate-limited", "recovered from", "still rate-limited",
                                    "STREAM-END", "Context overflow", "CONTENT_FILTERED", "Stream error",
                                    "meteringEvent")):
                print(f"      {ts.strftime('%H:%M:%S')} [{lv:5s}] {m[:150]}")
                seen += 1
                if seen > 26:
                    print("      ... (truncated)"); break
    if seen == 0:
        print("      (no matching upstream events found in window)")
