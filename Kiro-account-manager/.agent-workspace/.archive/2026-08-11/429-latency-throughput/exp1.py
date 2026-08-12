"""
CONTROLLED EXPERIMENT: maxAttempts=1 (per-endpoint 429 retry disabled).

Goal: measure the TRUE per-request 429 rate. With in-endpoint retry off, each
endpoint is tried once, so the proxy log's attempt count == distinct upstream
probes, and no single request can inflate the 429 denominator 10x.

Design (single variable = payload size; everything else fixed):
  - sequential, 4s spacing (avoid self-inflicted queueing)
  - 6 payload sizes x 4 reps
  - record client-visible status + latency, then cross-reference proxy log for
    per-attempt upstream status
"""
import os, json, time, threading, urllib.request, urllib.error, random, sys

BASE = "http://127.0.0.1:5580"
KEY = os.environ["KIRO_KEY"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exp-attempts1.jsonl")
LOCK = threading.Lock()

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike "
         "november oscar papa quebec romeo sierra tango uniform victor whiskey xray "
         "yankee zulu ").split()

def filler(tok, seed):
    rnd = random.Random(seed)
    return " ".join(rnd.choice(WORDS) for _ in range(int(tok * 0.78)))

def rec(row):
    with LOCK:
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        print(f"  [{row['label']:18s}] status={row['status']} ttft={row['ttft']} "
              f"total={row['total']:6.1f}s in={row.get('input_tokens')} "
              f"cache={row.get('cache_read')} {row.get('err','')[:60]}", flush=True)

def call(label, prompt, tag, timeout=600):
    body = {"model": "claude-opus-5", "max_tokens": 32, "stream": True,
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(BASE + "/v1/messages", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-api-key": KEY,
                 "Authorization": "Bearer " + KEY, "anthropic-version": "2023-06-01"},
        method="POST")
    t0 = time.time(); ttft = None; usage = {}; status = None; err = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            for raw in r:
                if ttft is None and (b"content_block_delta" in raw or b"content_block_start" in raw):
                    ttft = round(time.time() - t0, 2)
                if b"usage" in raw and raw.startswith(b"data:"):
                    try:
                        j = json.loads(raw.split(b"data:", 1)[1])
                        u = (j.get("message") or {}).get("usage") or j.get("usage") or {}
                        for k, v in u.items():
                            if isinstance(v, int): usage[k] = max(usage.get(k, 0), v)
                    except Exception: pass
    except urllib.error.HTTPError as e:
        status = e.code
        try: err = e.read().decode()[:200]
        except Exception: err = str(e)
    except Exception as e:
        status = -1; err = f"{type(e).__name__}: {e}"
    row = dict(ts=time.strftime("%H:%M:%S"), label=label, tag=tag, status=status,
               ttft=ttft, total=round(time.time()-t0, 2), pay=len(prompt),
               input_tokens=usage.get("input_tokens"),
               cache_read=usage.get("cache_read_input_tokens"), err=err)
    rec(row)
    return row

SIZES = [("20k", 20_000), ("60k", 60_000), ("120k", 120_000),
         ("200k", 200_000), ("300k", 300_000), ("400k", 400_000)]

if __name__ == "__main__":
    print(f"START {time.strftime('%H:%M:%S')}  (maxAttempts=1)", flush=True)
    reps = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    for name, tok in SIZES:
        for i in range(reps):
            call(f"a1/{name}/#{i}", filler(tok, f"{name}{i}{time.time()}") +
                 "\n\nReply with exactly: OK", tag=f"a1_{name}")
            time.sleep(4)
    print(f"END {time.strftime('%H:%M:%S')} -> {OUT}", flush=True)
