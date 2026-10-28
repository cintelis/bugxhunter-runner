"""A draw.io diagram -> a compact text outline a model can review.

Models misread small labels in pictures of diagrams; the .drawio source has the exact text and
the structure (which box sits in which zone, what each arrow connects). The raw XML is mostly
styling, so this keeps only what matters:

    # Page: Trust Zones
    Legend (colour meanings, already applied to boxes in [brackets]): Classical residual; PQ
    ## Zone: NVIDIA BLUEFIELD DPU (dashed border)
    - box [Classical residual]: HARDWARE ROOT OF TRUST / ECDSA P-384 ...
    ## Arrows
    - HARDWARE ROOT OF TRUST -> IN-HSM ATTESTATION VERIFIER  "SPDM v1.1 evidence"

Reads plain .drawio, compressed .drawio (draw.io's default) and .drawio.svg / .drawio.png-free
SVG exports that embed the diagram. Standard library only.
"""
from __future__ import annotations

import base64
import html
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zlib

MAX_CELLS = 5000
MAX_INFLATED = 20 * 1024 * 1024


class OutlineError(ValueError):
    pass


def _parse(text: str) -> ET.Element:
    # No DTDs: nothing in a draw.io file needs one, and refusing them rules out entity tricks.
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise OutlineError("the file declares a DTD or entities; draw.io files never do")
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise OutlineError(f"not valid XML: {e}") from None


def _inflate(data: str) -> str:
    """A compressed draw.io page: base64 of raw deflate of the URI-encoded XML."""
    try:
        raw = base64.b64decode(data.strip(), validate=False)
        d = zlib.decompressobj(-15)
        out = d.decompress(raw, MAX_INFLATED)
        if d.unconsumed_tail:
            raise OutlineError("a compressed page is too large")
        return urllib.parse.unquote(out.decode("utf-8"))
    except OutlineError:
        raise
    except Exception:
        raise OutlineError("could not decompress a page (is this a draw.io file?)") from None


def load_pages(text: str) -> list[tuple[str, ET.Element]]:
    """(page name, mxGraphModel) for each page in a .drawio, compressed .drawio or .drawio.svg."""
    text = text.lstrip("﻿")
    root = _parse(text)
    if root.tag.endswith("svg"):
        content = root.get("content")
        if not content or "mxfile" not in content and "mxGraphModel" not in content:
            raise OutlineError("this SVG has no draw.io diagram inside (export with 'Include a copy of my diagram')")
        root = _parse(html.unescape(content) if content.lstrip().startswith("&lt;") else content)
    if root.tag == "mxGraphModel":
        return [("Page 1", root)]
    if root.tag != "mxfile":
        raise OutlineError("not a draw.io file (expected <mxfile> or <mxGraphModel>)")
    pages = []
    for i, d in enumerate(root.findall("diagram")):
        model = d.find("mxGraphModel")
        if model is None and (d.text or "").strip():
            model = _parse(_inflate(d.text))
        if model is not None:
            pages.append((d.get("name") or f"Page {i + 1}", model))
    if not pages:
        raise OutlineError("the file has no pages")
    return pages


def _text(v: str | None) -> str:
    v = re.sub(r"<br\s*/?>|</div>|</p>|</li>", "\n", v or "", flags=re.I)
    v = html.unescape(re.sub(r"<[^>]+>", "", v))
    return " / ".join(l.strip() for l in v.splitlines() if l.strip())


def _style(s: str | None) -> dict[str, str]:
    return dict(p.split("=", 1) for p in (s or "").split(";") if "=" in p)


def _page(page_name: str, model: ET.Element) -> list[str]:
    cells = model.findall(".//mxCell")
    if len(cells) > MAX_CELLS:
        raise OutlineError(f"page '{page_name}' has {len(cells)} shapes (the limit is {MAX_CELLS})")
    V: dict[str, dict] = {}
    E: list[dict] = []
    # UserObject/object wrappers carry the label; the mxCell inside carries the geometry.
    labels = {o.get("id"): o.get("label") for o in model.iter() if o.tag in ("UserObject", "object")}
    parent_of = {c: p for p in model.iter() for c in p}
    for c in cells:
        cid = c.get("id") or (parent_of.get(c).get("id") if parent_of.get(c) is not None else None)
        value = c.get("value") if c.get("value") is not None else labels.get(cid)
        g = c.find("mxGeometry")
        st = _style(c.get("style"))
        if c.get("vertex") == "1" and g is not None:
            V[cid] = dict(id=cid, t=_text(value), st=st, raw=c.get("style") or "", parent=c.get("parent"),
                          x=float(g.get("x", 0)), y=float(g.get("y", 0)),
                          w=float(g.get("width", 0)), h=float(g.get("height", 0)))
        elif c.get("edge") == "1":
            pts = {p.get("as"): (float(p.get("x", 0)), float(p.get("y", 0)))
                   for p in (g.iter("mxPoint") if g is not None else [])}
            E.append(dict(id=cid, s=c.get("source"), t=c.get("target"), label=_text(value), st=st, pts=pts))

    # Edge labels can be child cells of the edge.
    by_edge = {e["id"]: e for e in E}
    for v in list(V.values()):
        if v["parent"] in by_edge and v["t"]:
            e = by_edge[v["parent"]]
            e["label"] = f'{e["label"]} / {v["t"]}' if e["label"] else v["t"]
            del V[v["id"]]

    # Child geometry is relative to its container in draw.io; make it absolute.
    def absolute(v, depth=0):
        p = V.get(v["parent"])
        if p is None or depth > 50:
            return v["x"], v["y"]
        px, py = absolute(p, depth + 1)
        return v["x"] + px, v["y"] + py
    for v in V.values():
        v["ax"], v["ay"] = absolute(v)

    def inside(a, b):
        return (a is not b and b["ax"] <= a["ax"] and b["ay"] <= a["ay"]
                and a["ax"] + a["w"] <= b["ax"] + b["w"] and a["ay"] + a["h"] <= b["ay"] + b["h"])

    is_note = lambda v: v["raw"].startswith("text;") or v["st"].get("text") == "" or "text;" in v["raw"][:6]

    # Legend: swatches inside the box titled "Legend"; boxes match by fill, or by border if tinted.
    legend: dict[str, str] = {}
    legend_stroke: dict[str, str] = {}
    legend_ids: set[str] = set()
    for lg in [v for v in V.values() if v["t"].lower() in ("legend", "key")]:
        box = min([z for z in V.values() if inside(lg, z)] or [lg], key=lambda z: z["w"] * z["h"])
        legend_ids |= {box["id"], lg["id"]}
        for v in V.values():
            if inside(v, box) and v["id"] != lg["id"] and v["t"]:
                legend_ids.add(v["id"])
                if v["st"].get("fillColor"):
                    legend.setdefault(v["st"]["fillColor"].lower(), v["t"])
                    if v["st"].get("strokeColor"):
                        legend_stroke.setdefault(v["st"]["strokeColor"].lower(), v["t"])

    def meaning(st):
        fill = st.get("fillColor", "").lower()
        if fill in legend:
            return legend[fill]
        if fill and fill not in ("#ffffff", "#fff", "none", "default"):
            return legend_stroke.get(st.get("strokeColor", "").lower())
        return None

    shapes = [v for v in V.values() if v["id"] not in legend_ids and (v["t"] or not is_note(v))]
    zones = [v for v in shapes if v["t"] and any(inside(o, v) for o in shapes)]
    zone_of = {}
    for v in shapes:
        holders = [z for z in zones if inside(v, z)]
        if holders:
            zone_of[v["id"]] = min(holders, key=lambda z: z["w"] * z["h"])["id"]

    def centre(vid):
        v = V.get(vid)
        return (v["ax"] + v["w"] / 2, v["ay"] + v["h"] / 2) if v else None

    def nearest(p):
        cands = [v for v in shapes if v["t"]]
        if not cands:
            return None
        return min(cands, key=lambda v: max(v["ax"] - p[0], 0, p[0] - v["ax"] - v["w"]) ** 2
                   + max(v["ay"] - p[1], 0, p[1] - v["ay"] - v["h"]) ** 2)["id"]

    for e in E:  # dangling ends: attach to the nearest shape
        if not e["s"] and "sourcePoint" in e["pts"]:
            e["s"] = nearest(e["pts"]["sourcePoint"])
        if not e["t"] and "targetPoint" in e["pts"]:
            e["t"] = nearest(e["pts"]["targetPoint"])

    # Free text near an unlabelled arrow is usually that arrow's label.
    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = dx * dx + dy * dy or 1
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
        return ((a[0] + t * dx - p[0]) ** 2 + (a[1] + t * dy - p[1]) ** 2) ** 0.5
    top = min((v["ay"] for v in shapes), default=0)
    used = set()
    for v in shapes:
        if not is_note(v) or not v["t"] or v["id"] in zone_of or v["ay"] < top + 60:
            continue
        cands = [(seg_dist(centre(v["id"]), centre(e["s"]), centre(e["t"])), e)
                 for e in E if centre(e["s"]) and centre(e["t"]) and not e["label"]]
        if cands:
            dist, e = min(cands, key=lambda c: c[0])
            if dist < 250:
                e["label"] = v["t"]
                used.add(v["id"])

    # Arrows name their ends by a box's first line; when several boxes share it ("EventBridge
    # Scheduler", "Diff"), add lines until the name is unique, so every arrow is unambiguous.
    first_counts: dict[str, int] = {}
    for v in V.values():
        if v["t"]:
            k = v["t"].split(" / ")[0]
            first_counts[k] = first_counts.get(k, 0) + 1

    def name(vid):
        v = V.get(vid)
        if not v or not v["t"]:
            return "(unlabelled shape)"
        parts = v["t"].split(" / ")
        if first_counts.get(parts[0], 0) < 2 or len(parts) == 1:
            return parts[0]
        return f"{parts[0]} ({parts[1]})"

    def line(m) -> str:
        tags = []
        if not is_note(m) and (tag := meaning(m["st"])):
            tags.append(tag)
        if m["st"].get("dashed") == "1":
            tags.append("dashed")
        if m["st"].get("fillColor", "").lower() in ("#cc0000", "#ff0000", "#e51400", "#b20000"):
            tags.append("red marker")
        if m["raw"].startswith("ellipse") or m["st"].get("shape") == "ellipse":
            tags.append("circle")
        if m["st"].get("fontColor", "").lower() in ("#cc0000", "#ff0000", "#b85450", "#c00000", "#e51400"):
            tags.append("red text")
        kind = "note" if is_note(m) else "box"
        return f"- {kind}{' [' + ', '.join(tags) + ']' if tags else ''}: {m['t'] or '(no text)'}"

    out = [f"# Page: {page_name}"]
    if legend:
        out.append("Legend (colour meanings, already applied to boxes in [brackets]): "
                   + "; ".join(sorted(set(legend.values()))))
    loose = [v for v in shapes if v["id"] not in zone_of and v not in zones and v["t"] and v["id"] not in used]
    if loose:
        out.append("\n## Outside any zone")
        out += [line(m) for m in sorted(loose, key=lambda v: (v["ay"], v["ax"]))]
    for z in sorted(zones, key=lambda v: (v["ay"], v["ax"])):
        parent = zone_of.get(z["id"])
        out.append(f"\n## Zone: {z['t']}" + (" (dashed border)" if z["st"].get("dashed") == "1" else "")
                   + (f" (inside zone: {name(parent)})" if parent else ""))
        members = [v for v in shapes if zone_of.get(v["id"]) == z["id"] and v not in zones and v["id"] not in used]
        out += [line(m) for m in sorted(members, key=lambda v: (v["ay"], v["ax"]))]
        if not members:
            out.append("- (only nested zones)")
    if E:
        out.append("\n## Arrows")
        for e in E:
            both = e["st"].get("startArrow", "none") not in ("none", "")
            plain = e["st"].get("endArrow") == "none" and not both
            arrow = "<->" if both else ("--" if plain else "->")
            dashed = " (dashed)" if e["st"].get("dashed") == "1" else ""
            label = f'  "{e["label"]}"' if e["label"] else ""
            out.append(f"- {name(e['s'])} {arrow} {name(e['t'])}{dashed}{label}")
    return out


def outline(text: str) -> dict:
    """The outline of every page, plus counts. Raises OutlineError for anything unreadable."""
    pages = load_pages(text)
    lines: list[str] = []
    for i, (page_name, model) in enumerate(pages):
        if i:
            lines.append("")
        lines += _page(page_name, model)
    body = "\n".join(lines).strip() + "\n"
    return {"outline": body, "pages": [p for p, _ in pages], "chars": len(body)}
