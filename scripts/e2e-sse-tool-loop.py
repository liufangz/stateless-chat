#!/usr/bin/env python3
"""Live E2E for the stateless-chat tool-call loop.

Flow: login (AUTH_PASSWORD from repo .env) -> create conversation ->
post a tool-triggering message -> read the SSE stream -> assert
tool_start/tool_end/token/done; then a plain message -> assert tokens+done
with ZERO tool events (backward compat).

Usage: python3 scripts/e2e-sse-tool-loop.py  (from repo root)
Exit 0 = PASS, 1 = FAIL. Requires only the running gateway on :3000.
"""
import http.client, json, sys, time, uuid

BASE = "127.0.0.1", 3000

def read_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env

env = read_env("/home/ubuntu/stateless-chat/.env")
PASS = env["AUTH_PASSWORD"]
CLIENT_ID = str(uuid.uuid4())

def req(method, path, body=None, cookies=None):
    conn = http.client.HTTPConnection(*BASE, timeout=30)
    headers = {}
    if body is not None:
        body = json.dumps(body)
        headers["Content-Type"] = "application/json"
    if cookies:
        headers["Cookie"] = cookies
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, resp.getheaders(), data

def get_cookie(headers):
    for k, v in headers:
        if k.lower() == "set-cookie":
            return v.split(";")[0]
    return None

def post_and_stream(conn_str, cookie, label):
    st, _, data = req("POST", f"/conversations/{conn_str}/messages",
                      {"clientId": CLIENT_ID, "content": content}, cookie)
    assert st == 200, f"post failed: {st} {data}"
    msg_id = json.loads(data)["messageId"]
    conn = http.client.HTTPConnection(*BASE, timeout=60)
    conn.request("GET", f"/conversations/{conn_str}/messages/{msg_id}/stream",
                 headers={"Cookie": cookie, "Accept": "text/event-stream"})
    resp = conn.getresponse()
    events, current = [], {}
    while True:
        line = resp.readline()
        if not line:
            break
        line = line.decode("utf-8", "replace").rstrip("\n")
        if line.startswith("event:"):
            current["event"] = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            current["data"] = line.split(":", 1)[1].strip()
        elif line == "":
            if current:
                events.append(current)
                current = {}
    conn.close()
    counts = {}
    for e in events:
        counts[e["event"]] = counts.get(e["event"], 0) + 1
    print(f"[{label}] events: {counts}")
    for e in events:
        if e["event"] in ("tool_start", "tool_end"):
            print(f"    {e['event']}: {e['data'][:140]}")
    return events

# 1. login
st, hdrs, data = req("POST", "/login", {"password": PASS})
cookie = get_cookie(hdrs)
assert st == 204, f"login failed: {st} {data}"
print("[1] login ok")

# 2. create conversation
st, _, data = req("POST", "/conversations", {"clientId": CLIENT_ID}, cookie)
assert st == 200, f"create conv failed: {st} {data}"
conversation_id = json.loads(data)["conversationId"]
print(f"[2] conversation {conversation_id}")

# 3a. tool-triggering message
content = "What time is it? Use the datetime tool."
print(f"[3a] tool message: {content!r}")
ev_a = post_and_stream(conversation_id, cookie, "3a")

# 3b. plain message (backward compat)
content = "Hello"
print(f"[3b] plain message: {content!r}")
ev_b = post_and_stream(conversation_id, cookie, "3b")

tool_starts_a = [e for e in ev_a if e["event"] == "tool_start"]
tool_ends_a = [e for e in ev_a if e["event"] == "tool_end"]
tool_b = [e for e in ev_b if e["event"] in ("tool_start", "tool_end")]
done_a = [e for e in ev_a if e["event"] == "done"]
done_b = [e for e in ev_b if e["event"] == "done"]

ok = True
if not tool_starts_a or not tool_ends_a:
    print("FAIL: expected tool_start/tool_end in tool message"); ok = False
if tool_b:
    print("FAIL: expected NO tool events in plain message"); ok = False
if not done_a or not done_b:
    print("FAIL: expected done in both"); ok = False
if not any(e["event"] == "token" for e in ev_b):
    print("FAIL: plain message streamed no token events"); ok = False
if not any(e["event"] == "token" for e in ev_a):
    print("WARN: tool message streamed no token events (may be tool-only turn)")

print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
if done_a:
    print("tool msg done:", done_a[0]["data"][:200])
sys.exit(0 if ok else 1)
