#!/usr/bin/env python3
"""Serve run-owned synthetic fixtures on loopback. Never fetch public site content."""

import argparse, hashlib, json, mimetypes, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs


def make_server(root, port):
    root = Path(root).resolve()
    events = root / "server-events.jsonl"
    lock = threading.Lock()

    def emit(data):
        with lock:
            with events.open("a", encoding="utf-8") as f:
                f.write(
                    json.dumps(dict(time=time.time(), **data), ensure_ascii=False)
                    + "\n"
                )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(
            self, status, data, mime="application/json; charset=utf-8", headers=None
        ):
            body = data if isinstance(data, bytes) else data.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            p = u.path
            if p == "/events":
                with lock:
                    body = (
                        "["
                        + ",".join(
                            events.read_text().splitlines() if events.exists() else []
                        )
                        + "]"
                    )
                return self.send(200, body)
            if p == "/frame":
                return self.send(
                    200,
                    """<!doctype html><meta charset="utf-8"><title>Frame controls</title><label>Frame name <input id="frame-name"></label><button id="frame-save">Save frame</button><output id="frame-result"></output><table id="frame-table"><caption>Frame orders</caption><thead><tr><th>ID</th><th>金额</th></tr></thead><tbody><tr><td>F-1</td><td>88.00</td></tr></tbody></table><script>document.querySelector('#frame-save').onclick=()=>{let v=document.querySelector('input').value;document.querySelector('output').textContent='Frame saved: '+v;fetch('/event',{method:'POST',body:JSON.stringify({type:'frame-save',value:v,host:location.host})})}</script>""",
                    "text/html; charset=utf-8",
                )
            if p == "/api/search":
                time.sleep(0.35)
                emit({"type": "api-search", "query": q})
                return self.send(
                    200,
                    json.dumps(
                        {
                            "items": [
                                {
                                    "id": "CN-42",
                                    "name": "中文 浏览器 🔍",
                                    "q": q.get("q", [""])[0],
                                }
                            ]
                        },
                        ensure_ascii=False,
                    ),
                )
            if p == "/api/slow":
                time.sleep(0.6)
                return self.send(
                    200, '{"ok":true,"source":"slow","nested":{"message":"完成 ✅"}}'
                )
            if p == "/api/fail":
                return self.send(500, '{"error":"synthetic-server-failure"}')
            if p == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/minimal")
                self.end_headers()
                return
            if p == "/download":
                data = "编号,名称\n42,中文文件 ✅\n".encode()
                emit({"type": "download", "sha256": hashlib.sha256(data).hexdigest()})
                return self.send(
                    200,
                    data,
                    "text/csv; charset=utf-8",
                    {
                        "Content-Disposition": "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%E6%8A%A5%E5%91%8A.csv"
                    },
                )
            name = "workbench.html" if p == "/" else p.lstrip("/")
            if "." not in name:
                name += ".html"
            file = (root / name).resolve()
            if file.parent != root or not file.is_file():
                return self.send(404, '{"error":"not-found"}')
            return self.send(
                200,
                file.read_bytes(),
                mimetypes.guess_type(str(file))[0] or "application/octet-stream",
            )

        def do_POST(self):
            n = int(self.headers.get("Content-Length", "0"))
            if n > 1048576:
                return self.send(413, '{"error":"too-large"}')
            body = self.rfile.read(n)
            try:
                data = json.loads(body)
            except ValueError:
                data = {"raw": body.decode(errors="replace")}
            emit({"path": self.path, "data": data})
            self.send(
                200, json.dumps({"ok": True, "received": data}, ensure_ascii=False)
            )

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", required=True)
    p.add_argument("--port", type=int, required=True)
    a = p.parse_args()
    server = make_server(a.root, a.port)
    print("Fixture server http://127.0.0.1:" + str(server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
