"""Which branch actually fires? Stop guessing at the predicate."""
import json, re
from collections import Counter
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
def t(r): return datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
print(f"rows={len(rows)}  {rows[0]['timestamp']} -> {rows[-1]['timestamp']}")

PAT = re.compile(r"HoldGate|挂起|放行|giveup|No account available|not found in pool|"
                 r"未挂起|hold|held|selected-account", re.I)
hits = [r for r in rows if PAT.search((r.get("message") or "") + " " + (r.get("category") or ""))]
print(f"\nhold-related rows: {len(hits)}")
print("\n=== shapes ===")
for s, n in Counter(re.sub(r"\d+", "N", (h.get('message') or ''))[:135] for h in hits).most_common(25):
    print(f"  {n:5d}x {s}")

print("\n=== chronological with data payload ===")
for r in hits[-45:]:
    d = r.get("data")
    extra = ""
    if isinstance(d, dict):
        extra = "  " + json.dumps(d, ensure_ascii=False)[:260]
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):11s} "
          f"{(r.get('message') or '')[:135]}{extra}")

print("\n=== pool state events (availableCount / replaceAll / lazy-refill) ===")
POOL = re.compile(r"lazy-refill|replaceAll|Hot-update|availableCount|未入反代池|池", re.I)
for r in [x for x in rows if POOL.search(x.get('message') or '')][-25:]:
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):11s} {(r.get('message') or '')[:170]}")

print("\n=== 503 / HOLD_TIMEOUT surfaced to client ===")
for r in [x for x in rows if re.search(r'HOLD_TIMEOUT|503', x.get('message') or '')][-15:]:
    print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {(r.get('message') or '')[:170]}")

print("\n=== perf-logs hold records ===")
import glob, os
for f in sorted(glob.glob(os.path.expandvars(r"%APPDATA%\kiro-account-manager\perf-logs\*.jsonl"))):
    print(f"  --- {os.path.basename(f)} ({os.path.getsize(f)} bytes) ---")
    with open(f, encoding="utf-8") as fh:
        for line in fh:
            try: rec = json.loads(line)
            except Exception: continue
            if rec.get("kind") == "hold":
                print(f"    {rec.get('ts','')[11:19]} {rec.get('event'):14s} "
                      f"reason={rec.get('reason')} released={rec.get('released')} "
                      f"held={rec.get('heldCount')} dur={rec.get('durationMs')}")
