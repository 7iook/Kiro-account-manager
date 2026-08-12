"""GPT vs Opus: compare stream-END shape per model. The question is why GPT halts mid-task."""
import json, re
from collections import Counter, defaultdict
from datetime import datetime

P = r"C:\Users\7\AppData\Roaming\kiro-account-manager\proxy-logs.json"
rows = json.load(open(P, encoding="utf-8"))
def t(r): return datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))

# STREAM-END lines carry the full forensic shape. Parse them.
SE = re.compile(
    r"exit=(\S+) residualBytes=(\d+) claimedTotalLength=(\d+) framesParsed=(\d+) "
    r"lastFrameLength=(\d+) upstreamStopReason=(\S+?)\((\S+?)\) semanticOutput=(\w+)")
PERF = re.compile(r"ep=(\S+) region=(\S+) TTFB=(\d+)ms status=(\d+) pay=(\d+)B")
MODEL = re.compile(r"\[model=([\w.\-:]+)\]|model=([\w.\-:]+)")

# Build a timeline of (ts, model) from any line that names a model, so we can
# attribute each STREAM-END to the nearest preceding model mention.
model_marks = []
for r in rows:
    m = MODEL.search(r.get("message") or "")
    if m:
        model_marks.append((t(r), m.group(1) or m.group(2)))
model_marks.sort(key=lambda x: x[0])

def model_at(ts):
    best = None
    for mt, mv in model_marks:
        if mt <= ts: best = mv
        else: break
    return best or "?"

ends = []
for r in rows:
    msg = r.get("message") or ""
    if "[STREAM-END]" not in msg: continue
    m = SE.search(msg)
    if not m: continue
    ends.append(dict(
        ts=t(r), exit=m.group(1), residual=int(m.group(2)),
        claimed=int(m.group(3)), frames=int(m.group(4)),
        lastLen=int(m.group(5)), stopReason=m.group(6), src=m.group(7),
        semantic=m.group(8) == "true", model=model_at(t(r))))

print(f"parsed STREAM-END records: {len(ends)}")
print("\n=== exit shape by MODEL ===")
g = defaultdict(lambda: Counter())
for e in ends:
    g[e["model"]][f"{e['exit']}/{e['stopReason']}"] += 1
for mdl in sorted(g, key=lambda k: -sum(g[k].values())):
    total = sum(g[mdl].values())
    print(f"\n  {mdl}  (n={total})")
    for shape, n in g[mdl].most_common(8):
        print(f"      {n:4d}  {shape}")

print("\n=== frames parsed distribution: is GPT cut short? ===")
for mdl in sorted(g, key=lambda k: -sum(g[k].values())):
    fr = sorted(e["frames"] for e in ends if e["model"] == mdl)
    if not fr: continue
    n = len(fr)
    print(f"  {mdl:20s} n={n:4d}  frames p10={fr[n//10]:6d} p50={fr[n//2]:6d} "
          f"p90={fr[int(n*0.9)]:6d} max={fr[-1]:6d}   tiny(<20 frames)={sum(1 for x in fr if x < 20)}")

print("\n=== TOOL_USE endings: how many frames before the tool call? ===")
print("    (a real 'halt mid-task' = TOOL_USE stop with few frames, client sees normal end)")
for mdl in sorted(g):
    tu = [e for e in ends if e["model"] == mdl and e["stopReason"] == "TOOL_USE"]
    et = [e for e in ends if e["model"] == mdl and e["stopReason"] == "END_TURN"]
    if not (tu or et): continue
    print(f"  {mdl:20s} TOOL_USE={len(tu):4d}  END_TURN={len(et):4d}  "
          f"ratio_END_TURN={len(et)/(len(tu)+len(et))*100:5.1f}%")

print("\n=== any non-clean exits? (the smoking gun for hard cuts) ===")
for e in ends:
    if e["exit"] != "clean_eof" or e["residual"] > 0:
        print(f"  {e['ts'].strftime('%H:%M:%S')} model={e['model']:18s} exit={e['exit']:22s} "
              f"residual={e['residual']:5d} frames={e['frames']:5d} stop={e['stopReason']:10s} "
              f"semantic={e['semantic']}")

print("\n=== GPT-specific rows anywhere in the log ===")
for r in rows:
    msg = r.get("message") or ""
    if re.search(r"gpt", msg, re.I):
        print(f"  {t(r).strftime('%H:%M:%S')} [{r.get('level'):5s}] {r.get('category'):12s} {msg[:165]}")
