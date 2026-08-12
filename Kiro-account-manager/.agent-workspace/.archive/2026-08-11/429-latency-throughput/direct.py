"""
DIRECT-TO-KIRO stress test using raw ksk_ keys, bypassing our proxy.

Why direct: our proxy retries internally, so a client-side 429 rate is invisible.
Hitting the upstream endpoint ourselves gives ONE attempt per request => the true
per-REQUEST 429 rate, which is the number my earlier analysis got wrong (I had
counted per-ATTEMPT, so one big request retrying 30x contributed 30 samples).

Endpoint + headers replicate what kiroApi.ts sends (see KIRO_ENDPOINTS + buildHeaders).
"""
import os, json, time, sys, threading, urllib.request, urllib.error, random
from collections import Counter

KEYS = [k.strip() for k in os.environ["KSK_KEYS"].split(",") if k.strip()]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "direct.jsonl")
LOCK = threading.Lock()

EP_US = "https://runtime.us-east-1.kiro.dev/"
EP_EU = "https://runtime.eu-central-1.kiro.dev/"
TARGET = "KiroRuntimeService.GenerateAssistantResponse"

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike "
         "november oscar papa quebec romeo sierra tango uniform victor whiskey xray "
         "yankee zulu ").split()

def filler(tokens, seed):
    rnd = random.Random(seed)
    return " ".join(rnd.choice(WORDS) for _ in range(int(tokens * 0.78)))

def rec(row):
    with LOCK:
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        print(f"  [{row['label']}] status={row['status']} ttfb={row['ttfb']}ms "
              f"pay={row['pay']/1e6:.2f}MB key={row['key']} {row.get('err','')[:70]}")

def build(prompt, model="claude-opus-5"):
    # conversationState shape per kiroApi.ts buildKiroPayload (generateAssistantResponse)
    return {
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": f"stress-{random.randint(10**9, 10**10)}",
            "currentMessage": {
                "userInputMessage": {
                    "content": prompt,
                    "modelId": model,
                    "origin": "AI_EDITOR",
                    "userInputMessageContext": {}
                }
            },
            "history": []
        }
    }

def call(label, prompt, key, ep=EP_US, timeout=300):
    payload = json.dumps(build(prompt)).encode()
    req = urllib.request.Request(ep, data=payload, method="POST", headers={
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": TARGET,
        "Authorization": f"Bearer {key}",
        "TokenType": "API_KEY",
        "User-Agent": "aws-sdk-js/1.0.116 KiroIDE",
    })
    t0 = time.time(); status = None; err = ""; nbytes = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            ttfb = round((time.time() - t0) * 1000)
            nbytes = len(r.read(65536))
    except urllib.error.HTTPError as e:
        status = e.code
        ttfb = round((time.time() - t0) * 1000)
        try: err = e.read().decode()[:200]
        except Exception: err = str(e)
    except Exception as e:
        status = -1
        ttfb = round((time.time() - t0) * 1000)
        err = f"{type(e).__name__}: {e}"
    row = dict(ts=time.strftime("%H:%M:%S"), label=label, status=status, ttfb=ttfb,
               pay=len(payload), key=key[-6:], ep="US" if ep == EP_US else "EU",
               got=nbytes, err=err)
    rec(row)
    return row

def exp_size_ladder():
    """TRUE per-request 429 rate vs payload. One attempt each, no retry."""
    print("\n=== DIRECT: per-request 429 rate vs payload size ===")
    sizes = [("10k", 10_000), ("50k", 50_000), ("100k", 100_000),
             ("200k", 200_000), ("300k", 300_000), ("400k", 400_000)]
    res = {}
    for name, tok in sizes:
        got = []
        for i in range(5):
            k = KEYS[i % len(KEYS)]
            got.append(call(f"size/{name}/#{i}", filler(tok, f"{name}{i}{time.time()}"), k)["status"])
            time.sleep(2)
        res[name] = Counter(got)
        print(f"  -> {name}: {dict(res[name])}")
    print("\n  SUMMARY per-request 429 rate by size:")
    for n, c in res.items():
        tot = sum(c.values())
        print(f"    {n:5s} n={tot} 429={c.get(429,0)} rate={c.get(429,0)*100/tot:.0f}% "
              f"200={c.get(200,0)} other={ {k:v for k,v in c.items() if k not in (200,429)} }")

def exp_burst(tok=200_000, n=12):
    """How fast does ONE key hit the wall when firing big requests back-to-back?"""
    print(f"\n=== DIRECT: single-key burst, {n} x {tok//1000}k tokens, no gap ===")
    k = KEYS[0]
    for i in range(n):
        call(f"burst/#{i}", filler(tok, f"b{i}{time.time()}"), k)

def exp_recovery(tok=200_000):
    """After a 429, how long until the SAME key succeeds? (early-stop vs wait)"""
    print(f"\n=== DIRECT: 429 recovery time probe ===")
    k = KEYS[0]
    # saturate first
    for i in range(6):
        r = call(f"sat/#{i}", filler(tok, f"s{i}{time.time()}"), k)
        if r["status"] == 429:
            print(f"  hit 429 at attempt {i}; now probing recovery...")
            break
    for wait in (0.05, 0.5, 2, 5, 10, 20, 40):
        time.sleep(wait)
        r = call(f"recover/after{wait}s", filler(tok, f"r{wait}{time.time()}"), k)
        if r["status"] == 200:
            print(f"  ==> recovered after cumulative wait ~{wait}s")
            break

if __name__ == "__main__":
    w = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"keys loaded: {len(KEYS)}")
    if w in ("all", "size"): exp_size_ladder()
    if w in ("all", "burst"): exp_burst()
    if w in ("all", "recover"): exp_recovery()
