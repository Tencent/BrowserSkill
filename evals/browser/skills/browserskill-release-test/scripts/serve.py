#!/usr/bin/env python3
"""Serve run-owned synthetic fixtures on loopback. Never fetch public site content."""

import argparse, hashlib, json, mimetypes, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs


EXTRA_MIMES = {
    ".html": "text/html; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}

BFCACHE_PATHS = {
    "/arena-bfcache-detail",
    "/arena-bfcache-detail.html",
    "/arena-modern-spa-grid",
    "/arena-modern-spa-grid.html",
}


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
            hdrs = dict(headers or {})
            cache_control = hdrs.pop("Cache-Control", "no-store")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
            self.send_header(
                "Access-Control-Expose-Headers",
                "Accept-Ranges, Content-Length, Content-Range",
            )
            for k, v in hdrs.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command == "HEAD":
                return
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def send_static(self, raw, mime, headers=None):
            hdrs = dict(headers or {})
            hdrs["Accept-Ranges"] = "bytes"
            range_hdr = self.headers.get("Range", "").strip()
            if not range_hdr or not range_hdr.startswith("bytes=") or "," in range_hdr:
                return self.send(200, raw, mime, hdrs)
            total = len(raw)
            spec = range_hdr[6:].strip()
            if total == 0 or "-" not in spec:
                hdrs["Content-Range"] = f"bytes */{total}"
                return self.send(416, b"", mime, hdrs)
            start_s, end_s = spec.split("-", 1)
            try:
                if start_s == "":
                    suffix = int(end_s)
                    if suffix <= 0:
                        raise ValueError("empty suffix")
                    start = max(0, total - suffix)
                    end = total - 1
                else:
                    start = int(start_s)
                    raw_end = total - 1 if end_s == "" else int(end_s)
                    if start < 0 or start >= total or raw_end < start:
                        raise ValueError("out of bounds")
                    end = min(total - 1, raw_end)
            except ValueError:
                hdrs["Content-Range"] = f"bytes */{total}"
                return self.send(416, b"", mime, hdrs)
            hdrs["Content-Range"] = f"bytes {start}-{end}/{total}"
            return self.send(206, raw[start : end + 1], mime, hdrs)

        def do_HEAD(self):
            self.do_GET()

        def do_OPTIONS(self):
            self.send(204, b"", "text/plain; charset=utf-8")

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
            if p == "/redirect-cross-origin":
                host_hdr = self.headers.get("Host", f"127.0.0.1:{self.server.server_port}")
                srv_port = (
                    host_hdr.rsplit(":", 1)[1]
                    if ":" in host_hdr
                    else str(self.server.server_port)
                )
                target_host = (
                    "127.0.0.1" if host_hdr.startswith("localhost") else "localhost"
                )
                dest = (
                    f"http://{target_host}:{srv_port}"
                    f"/arena-bfcache-detail?from=cross_origin_302&bfcache=1"
                )
                emit(
                    {
                        "type": "redirect-cross-origin",
                        "from_host": host_hdr,
                        "to": dest,
                    }
                )
                self.send_response(302)
                self.send_header("Location", dest)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            if p == "/slow-doc":
                try:
                    delay_ms = int(float(q.get("delay_ms", ["650"])[0]))
                except ValueError:
                    delay_ms = 650
                delay_ms = max(0, min(3000, delay_ms))
                time.sleep(delay_ms / 1000.0)
                emit({"type": "slow-doc", "delay_ms": delay_ms})
                html = (
                    f'<!doctype html><meta charset="utf-8"><title>Slow Document ({delay_ms}ms)</title>'
                    f'<main id="slow-doc-ready" data-delay-ms="{delay_ms}">'
                    f'<h1>Delayed Document Ready</h1><p id="slow-doc-meta">delay_ms={delay_ms}</p>'
                    f'<a id="slow-doc-back" href="/arena-modern-spa-grid">返回 SPA 主大盘</a></main>'
                )
                return self.send(200, html, "text/html; charset=utf-8")
            if p == "/download":
                scene = q.get("scene", [""])[0]
                if scene == "joint-filing":
                    org = q.get("org", ["未命名牵头单位"])[0]
                    gross = q.get("gross", ["0.00"])[0]
                    data = (
                        f"核定单号,牵头单位,含税总额(万元),状态\n"
                        f"JNT-COMMIT-2026-9901,{org},{gross},已联合核定 ✅\n"
                    ).encode("utf-8")
                    sha = hashlib.sha256(data).hexdigest()
                    emit(
                        {
                            "type": "download",
                            "scene": "joint-filing",
                            "org": org,
                            "gross": gross,
                            "sha256": sha,
                        }
                    )
                    return self.send(
                        200,
                        data,
                        "text/csv; charset=utf-8",
                        {
                            "Content-Disposition": "attachment; filename*=UTF-8''%E8%81%94%E5%90%88%E7%94%B3%E6%8A%A5%E6%A0%B8%E5%AE%9A%E5%8D%95.csv"
                        },
                    )
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
            if p == "/download-stream":
                try:
                    chunks = max(1, min(20, int(q.get("chunks", ["4"])[0])))
                    chunk_ms = max(0, min(500, int(q.get("chunk_ms", ["50"])[0])))
                except ValueError:
                    chunks, chunk_ms = 4, 50
                parts = ["批次,条目,校验标记\n"] + [
                    f"{idx},流式对账分片-{idx},OK ✅\n" for idx in range(1, chunks + 1)
                ]
                raw_parts = [s.encode("utf-8") for s in parts]
                full_bytes = b"".join(raw_parts)
                emit(
                    {
                        "type": "download-stream",
                        "chunks": chunks,
                        "sha256": hashlib.sha256(full_bytes).hexdigest(),
                    }
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Length", str(len(full_bytes)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header(
                    "Content-Disposition",
                    "attachment; filename*=UTF-8''%E6%B5%81%E5%BC%8F%E5%AF%B9%E8%B4%A6%E5%8D%95.csv",
                )
                self.end_headers()
                try:
                    for part in raw_parts:
                        if chunk_ms:
                            time.sleep(chunk_ms / 1000.0)
                        self.wfile.write(part)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if p in ("/recipe/report", "/recipe/form", "/recipe/login"):
                lab = (root / "plan-recipe-lab.html").resolve()
                if lab.is_file():
                    return self.send(200, lab.read_bytes(), "text/html; charset=utf-8")
            name = "workbench.html" if p == "/" else p.lstrip("/")
            if "." not in name:
                name += ".html"
            file = (root / name).resolve()
            if file.parent != root or not file.is_file():
                return self.send(404, '{"error":"not-found"}')
            mime = (
                EXTRA_MIMES.get(file.suffix.lower())
                or mimetypes.guess_type(str(file))[0]
                or "application/octet-stream"
            )
            hdrs = {}
            if p in BFCACHE_PATHS or q.get("bfcache") == ["1"]:
                hdrs["Cache-Control"] = "public, max-age=300"
            return self.send_static(file.read_bytes(), mime, hdrs)

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
