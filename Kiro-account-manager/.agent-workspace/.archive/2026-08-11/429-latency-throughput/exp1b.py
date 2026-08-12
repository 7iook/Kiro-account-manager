import os, time, importlib.util, sys
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("exp1", os.path.join(here, "exp1.py"))
m = importlib.util.module_from_spec(spec)
sys.modules["exp1"] = m
spec.loader.exec_module(m)

# remaining: 300k x4, 400k x4  (200k already has 3, add 1 more)
plan = [("200k", 200_000, 1), ("300k", 300_000, 4), ("400k", 400_000, 4)]
print(f"START {time.strftime('%H:%M:%S')}", flush=True)
for name, tok, reps in plan:
    for i in range(reps):
        m.call(f"a1/{name}/#r{i}", m.filler(tok, f"{name}r{i}{time.time()}") +
               "\n\nReply with exactly: OK", tag=f"a1_{name}")
        time.sleep(4)
print(f"END {time.strftime('%H:%M:%S')}", flush=True)
