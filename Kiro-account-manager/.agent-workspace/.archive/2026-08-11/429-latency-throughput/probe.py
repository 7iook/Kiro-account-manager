import os, json, time, urllib.request

BASE = "http://127.0.0.1:5580"
KEY  = os.environ["KIRO_KEY"]

def post(path, body, stream=False, timeout=300):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + KEY,
                 "x-api-key": KEY,
                 "anthropic-version": "2023-06-01"},
        method="POST")
    t0 = time.time()
    ttft = None
    out = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        status = r.status
        if stream:
            for line in r:
                if ttft is None and line.startswith(b"data:") and b"content_block_delta" in line:
                    ttft = time.time() - t0
                out.append(line)
        else:
            out.append(r.read())
    return status, ttft, time.time() - t0, b"".join(out)

print("=== connectivity probe (tiny request) ===")
try:
    st, ttft, tot, body = post("/v1/messages", {
        "model": "claude-opus-5",
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}]
    })
    print(f"  status={st} total={tot:.2f}s")
    d = json.loads(body)
    txt = "".join(c.get("text","") for c in d.get("content",[]))
    print(f"  reply={txt!r}")
    print(f"  usage={d.get('usage')}")
except Exception as e:
    print(f"  FAILED: {type(e).__name__}: {e}")
    import traceback; traceback.print_exc()
