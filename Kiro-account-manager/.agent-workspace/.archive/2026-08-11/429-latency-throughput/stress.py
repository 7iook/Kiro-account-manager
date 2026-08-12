"""
Real controlled experiment against the live proxy at 127.0.0.1:5580.

DESIGN
  We cannot control the proxy's internal 429 retry from outside, so we measure the
  thing we CAN control and that the RCA claims is decisive: the cost of a large
  upload and how outcome depends on inter-request spacing + payload size + concurrency.

  Variables (one at a time):
    A. payload size:  ~30k / 100k / 150k / 300k tokens
    B. spacing between requests: 0s / 2s / 10s
    C. concurrency: 1 / 2 / 4

  Recorded per request: timestamp, model, input_tokens, output_tokens, cache_tokens,
  TTFT, total_latency, status, error, credits(if exposed).

  Everything appends to results.jsonl so a run can be killed and still keep data.
"""
import os, json, time, threading, urllib.request, urllib.error, random, sys

BASE = "http://127.0.0.1:5580"
KEY  = os.environ["KIRO_KEY"]
OUT  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results.jsonl")
LOCK = threading.Lock()

# ~4 chars per token; build filler that is UNIQUE per request to defeat prompt cache
# when we want cold measurements, or SHARED to measure cache benefit.
WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
         "mike november oscar papa quebec romeo sierra tango uniform victor whiskey "
         "xray yankee zulu ").split()

def filler(tokens, seed):
    rnd = random.Random(seed)
    n = int(tokens * 0.78)          # ~1.28 tokens per word
    return " ".join(rnd.choice(WORDS) for _ in range(n))

def record(row):
    with LOCK:
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"  [{row['label']}] status={row['status']} in={row.get('input_tokens')} "
              f"cache={row.get('cache_read')} ttft={row['ttft']} total={row['total']:.2f}s "
              f"{row.get('error','')[:80]}")

def call(label, model, prompt, max_tokens=32, stream=True, timeout=600, tag=None):
    body = {"model": model, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]}
    if stream: body["stream"] = True
    req = urllib.request.Request(
        BASE + "/v1/messages", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-api-key": KEY,
                 "Authorization": "Bearer " + KEY, "anthropic-version": "2023-06-01"},
        method="POST")
    t0 = time.time(); ttft = None
    usage = {}; status = None; err = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            if stream:
                for raw in r:
                    if ttft is None and (b"content_block_delta" in raw or b'"text_delta"' in raw
                                         or b"content_block_start" in raw):
                        ttft = round(time.time() - t0, 3)
                    if b"usage" in raw and raw.startswith(b"data:"):
                        try:
                            j = json.loads(raw.split(b"data:", 1)[1])
                            u = (j.get("message") or {}).get("usage") or j.get("usage") or {}
                            for k, v in u.items():
                                if isinstance(v, int): usage[k] = max(usage.get(k, 0), v)
                        except Exception: pass
            else:
                j = json.loads(r.read()); usage = j.get("usage", {})
    except urllib.error.HTTPError as e:
        status = e.code
        try: err = e.read().decode()[:400]
        except Exception: err = str(e)
    except Exception as e:
        status = -1; err = f"{type(e).__name__}: {e}"
    row = dict(ts=time.strftime("%Y-%m-%d %H:%M:%S"), label=label, tag=tag, model=model,
               prompt_chars=len(prompt), status=status, ttft=ttft,
               total=round(time.time()-t0, 3),
               input_tokens=usage.get("input_tokens"),
               output_tokens=usage.get("output_tokens"),
               cache_read=usage.get("cache_read_input_tokens"),
               cache_write=usage.get("cache_creation_input_tokens"),
               error=err)
    record(row)
    return row

MODEL = "claude-opus-5"
SIZES = [("30k", 30_000), ("100k", 100_000), ("150k", 150_000), ("300k", 300_000)]

def exp_A_payload_ladder(reps=3):
    """A: does payload size drive latency / 429?  spacing fixed at 3s, concurrency 1"""
    print("\n=== EXP A: payload ladder (seq, 3s spacing) ===")
    for name, tok in SIZES:
        for i in range(reps):
            p = filler(tok, seed=f"A-{name}-{i}-{time.time()}") + "\n\nReply with exactly: OK"
            call(f"A/{name}/#{i}", MODEL, p, tag="A_payload")
            time.sleep(3)

def exp_B_spacing(tok=150_000, reps=4):
    """B: does inter-request spacing change 429 rate at fixed size?"""
    print("\n=== EXP B: spacing sweep @150k ===")
    for gap in (0, 2, 10):
        for i in range(reps):
            p = filler(tok, seed=f"B-{gap}-{i}-{time.time()}") + "\n\nReply with exactly: OK"
            call(f"B/gap{gap}s/#{i}", MODEL, p, tag=f"B_gap{gap}")
            if gap: time.sleep(gap)

def exp_C_concurrency(tok=150_000):
    """C: concurrency 1/2/4 at fixed size — the thundering-herd test"""
    print("\n=== EXP C: concurrency sweep @150k ===")
    for c in (1, 2, 4):
        ths = []
        for i in range(c):
            p = filler(tok, seed=f"C-{c}-{i}-{time.time()}") + "\n\nReply with exactly: OK"
            t = threading.Thread(target=call, args=(f"C/conc{c}/#{i}", MODEL, p),
                                 kwargs=dict(tag=f"C_conc{c}"))
            ths.append(t)
        for t in ths: t.start()
        for t in ths: t.join()
        time.sleep(5)

def exp_D_cache(tok=150_000, rounds=4):
    """D: multi-turn with SHARED prefix — measures prompt-cache benefit on TTFT"""
    print("\n=== EXP D: multi-turn shared prefix (cache) ===")
    shared = filler(tok, seed="D-STABLE-PREFIX")
    for i in range(rounds):
        p = shared + f"\n\nTurn {i}. Reply with exactly: OK"
        call(f"D/turn{i}", MODEL, p, tag="D_cache")
        time.sleep(2)

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    t0 = time.time()
    if which in ("all", "A"): exp_A_payload_ladder()
    if which in ("all", "B"): exp_B_spacing()
    if which in ("all", "C"): exp_C_concurrency()
    if which in ("all", "D"): exp_D_cache()
    print(f"\ndone in {time.time()-t0:.0f}s -> {OUT}")
