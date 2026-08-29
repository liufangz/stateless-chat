#!/usr/bin/env python3
"""Live E2E: bash tool runs as uid 1000 (opc) and .env stays sealed.

Login -> create conv -> post message forcing the bash tool ->
SSE to done -> GET /tools -> assert bash result shows uid=1000(opc)
and .env Permission denied.
"""
import http.client, json, sys, uuid

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

st, hdrs, data = req("POST", "/login", {"password": PASS})
cookie = get_cookie(hdrs)
assert st == 204, f"login failed: {st} {data}"
print("[1] login ok")

st, _, data = req("POST", "/conversations", {"clientId": CLIENT_ID}, cookie)
assert st == 200, f"create conv failed: {st} {data}"
conversation_id = json.loads(data)["conversationId"]
print(f"[2] conversation {conversation_id}")

content = ("Use the bash tool twice. First run: id; echo HOME=$HOME . "
           "Second run: cat .env 2>&1 | head -1 . "
           "You must use the bash tool. Report exactly what each printed.")
print(f"[3] posting: {content!r}")
st, _, data = req("POST", f"/conversations/{conversation_id}/messages",
                  {"clientId": CLIENT_ID, "content": content}, cookie)
assert st == 200, f"post failed: {st} {data}"
msg_id = json.loads(data)["messageId"]
print(f"[3] user message {msg_id}")

conn = http.client.HTTPConnection(*BASE, timeout=120)
conn.request("GET", f"/conversations/{conversation_id}/messages/{msg_id}/stream",
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
print(f"[4] SSE events: {counts}")
for e in events:
    if e["event"] in ("tool_start", "tool_end"):
        print(f"    {e['event']}: {e['data'][:130]}")

st, _, data = req("GET", f"/conversations/{conversation_id}/messages/{msg_id}/tools",
                  cookies=cookie)
assert st == 200, f"tools endpoint failed: {st} {data}"
tools = json.loads(data)["toolCalls"]
print(f"[5] /tools returned {len(tools)} calls")

bash_results = [t for t in tools if t["name"] == "bash"]
ok = True
if not bash_results:
    print("FAIL: no bash tool calls persisted")
    ok = False
else:
    all_r = " ".join(t.get("result", "") for t in bash_results)
    for t in bash_results:
        r = t.get("result", "")
        print(f"    bash result ({'err' if t.get('isError') else 'ok'}): {r[:160]!r}")
    if "uid=1000(opc)" not in all_r:
        print("FAIL: no bash result shows uid=1000(opc)")
        ok = False
    if "Permission denied" not in all_r:
        print("FAIL: no bash result shows .env Permission denied")
        ok = False

print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
