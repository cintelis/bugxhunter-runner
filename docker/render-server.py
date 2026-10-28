"""BugXHunter render service: diagram specs written by models -> editable .drawio.svg.

Runs in its own container (docker/render.Dockerfile) on an internal network that only the
runner shares: no internet, no volumes, no secrets, read-only filesystem. Each request is
built in a fresh worker process with a time limit, so a pathological spec can only waste
its own few seconds.

    POST /drawio          {"spec": <YAML/JSON text or object>}
                          -> 200 {"svg", "xml", "title", "check": {...}}  or  422 {"error": {"message"}}
    POST /drawio/outline  {"file": <.drawio, compressed .drawio or .drawio.svg text>}
                          -> 200 {"outline", "pages", "chars"}  or  422 {"error": {"message"}}
    GET  /health   -> {"ok": true, "drawgen": "<version>"}

Uses drawgen (https://github.com/cintelis/drawio-tools) with its built-in renderer; the SVG
embeds the diagram, so draw.io opens it for editing and redraws it exactly on save.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("RENDER_PORT", "8080"))
MAX_BODY = {"/drawio": 256 * 1024,               # a spec is a few KB
            "/drawio/outline": 3 * 1024 * 1024}   # a diagram file a person drew
MAX_ITEMS = 400                # nodes + edges + zones + texts across all pages
TIMEOUT_S = 10
MAX_PARALLEL = 4


def merge_parallel_edges(page: dict) -> int:
    """Join edges between the same two nodes into one: drawn separately, they land on top of
    each other with unreadable labels (the checker does not flag it). Returns how many merged."""
    edges = page.get("edges")
    if not isinstance(edges, list):
        return 0
    kept: list = []
    first: dict = {}
    merged = 0
    for e in edges:
        if not isinstance(e, dict) or "from" not in e or "to" not in e:
            kept.append(e)
            continue
        key = (str(e["from"]), str(e["to"]))
        if key not in first:
            first[key] = dict(e)
            kept.append(first[key])
            continue
        merged += 1
        a, b = first[key].get("label"), e.get("label")
        if b and b != a:
            first[key]["label"] = f"{a}\n{b}" if a else b  # one per line
    page["edges"] = kept
    return merged


def worker() -> None:
    """One render, in its own process: JSON request on stdin, JSON result on stdout."""
    try:  # cap memory (Linux, i.e. the container); elsewhere the timeout still applies
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    except ImportError:
        pass
    from drawgen import SpecError, build, check_xml
    from drawgen.spec import load
    from drawgen.svg_render import render_svg

    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if req.get("op") == "outline":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves it off
        from drawio_outline import OutlineError, outline
        try:
            out = outline(str(req.get("file") or ""))
        except OutlineError as e:
            out = {"error": {"message": str(e)}}
        json.dump(out, sys.stdout)
        return
    spec = req.get("spec")
    try:
        if isinstance(spec, str):
            spec = load(spec)
        if not isinstance(spec, dict):
            raise SpecError("a spec must be a mapping (YAML or JSON object) at the top level")
        pages = spec.get("pages") if isinstance(spec.get("pages"), list) else [spec]
        count = sum(len(p.get(k) or []) for p in pages if isinstance(p, dict)
                    for k in ("nodes", "edges", "zones", "texts", "entities") if isinstance(p.get(k) or [], list))
        if count > MAX_ITEMS:
            raise SpecError(f"too big: {count} items (the limit is {MAX_ITEMS}); split it into smaller diagrams")
        merged = sum(merge_parallel_edges(p) for p in pages if isinstance(p, dict))
        xml = build(spec).xml()
        report = check_xml(xml, path="diagram").to_dict()
        svg = render_svg(xml, page=0, embed=xml)
        title = (pages[0].get("title") if isinstance(pages[0], dict) else None) or "diagram"
        out = {"svg": svg, "xml": xml, "title": str(title), "check": report, "merged_edges": merged}
    except (SpecError, ValueError) as e:
        out = {"error": {"message": str(e)}}
    except Exception as e:  # YAML syntax errors and the like: report them for the model to fix
        import yaml
        if not isinstance(e, yaml.YAMLError):
            raise
        out = {"error": {"message": "YAML syntax error (quote labels that contain : ? # { } [ ] or ,): "
                                    + " ".join(str(e).split())}}
    json.dump(out, sys.stdout)


class Handler(BaseHTTPRequestHandler):
    server_version = "bxh-render"

    def log_message(self, fmt, *args):  # one short line per request, no bodies
        sys.stderr.write("[render] %s %s\n" % (self.command, self.path))

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            from drawgen import __version__
            return self._send(200, {"ok": True, "drawgen": __version__})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        limit = MAX_BODY.get(self.path)
        if not limit:
            return self._send(404, {"error": {"message": "not found"}})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            return self._send(413, {"error": {"message": f"the request must be between 1 byte and {limit // 1024} KB"}})
        body = self.rfile.read(n)
        if self.path == "/drawio/outline":  # tell the worker which job; the body stays untouched JSON
            try:
                body = json.dumps({"op": "outline", "file": json.loads(body).get("file")}).encode()
            except (json.JSONDecodeError, AttributeError):
                return self._send(400, {"error": {"message": "expected JSON {\"file\": ...}"}})
        if not SLOTS.acquire(timeout=TIMEOUT_S):
            return self._send(503, {"error": {"message": "the renderer is busy; try again"}})
        try:
            p = subprocess.run([sys.executable, "-I", __file__, "--worker"], input=body,
                               capture_output=True, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return self._send(422, {"error": {"message": f"rendering took longer than {TIMEOUT_S}s; simplify the diagram"}})
        finally:
            SLOTS.release()
        try:
            out = json.loads(p.stdout or b"{}")
        except json.JSONDecodeError:
            out = {}
        if p.returncode != 0 or not out:
            sys.stderr.write(p.stderr.decode(errors="replace")[-2000:])
            return self._send(500, {"error": {"message": "the renderer failed on this input"}})
        self._send(422 if "error" in out else 200, out)


if __name__ == "__main__":
    if "--worker" in sys.argv:
        worker()
    else:
        import threading

        SLOTS = threading.BoundedSemaphore(MAX_PARALLEL)
        print(f"[render] listening on :{PORT}", flush=True)
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
