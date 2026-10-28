"""python -m unittest discover -s docker -p "test_*.py"  (standard library only)"""
import base64
import html
import os
import sys
import unittest
import urllib.parse
import zlib

sys.path.insert(0, os.path.dirname(__file__))
from drawio_outline import OutlineError, outline  # noqa: E402

MODEL = """<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="zone" value="DMZ" style="rounded=1;dashed=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="100" width="400" height="300" as="geometry"/></mxCell>
<mxCell id="web" value="Web &lt;b&gt;server&lt;/b&gt;&lt;br&gt;nginx 1.18" style="rounded=1;fillColor=#FDE9C8;strokeColor=#C08A00;" vertex="1" parent="1"><mxGeometry x="20" y="140" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="grp" value="Tier" style="swimlane;" vertex="1" parent="1"><mxGeometry x="500" y="100" width="300" height="200" as="geometry"/></mxCell>
<mxCell id="db" value="Postgres" style="shape=cylinder;" vertex="1" parent="grp"><mxGeometry x="20" y="40" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="e1" value="SQL" style="endArrow=block;" edge="1" parent="1" source="web" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" value="" style="endArrow=block;startArrow=block;dashed=1;" edge="1" parent="1" source="db" target="web"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2l" value="replication" style="edgeLabel;" vertex="1" connectable="0" parent="e2"><mxGeometry x="0" y="0" as="geometry"/></mxCell>
<mxCell id="lg" value="Legend" style="text;" vertex="1" parent="1"><mxGeometry x="900" y="0" width="200" height="90" as="geometry"/></mxCell>
<mxCell id="lgbox" value="" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="890" y="-10" width="220" height="110" as="geometry"/></mxCell>
<mxCell id="sw" value="Classical residual" style="fillColor=#FDE9C8;strokeColor=#C08A00;" vertex="1" parent="1"><mxGeometry x="900" y="40" width="150" height="24" as="geometry"/></mxCell>
</root></mxGraphModel>"""
PLAIN = f'<mxfile host="test"><diagram id="p" name="Main">{MODEL}</diagram></mxfile>'


def compressed(xml: str) -> str:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    data = c.compress(urllib.parse.quote(xml).encode()) + c.flush()
    return f'<mxfile><diagram name="Main">{base64.b64encode(data).decode()}</diagram></mxfile>'


class Outline(unittest.TestCase):
    def check(self, text):
        o = outline(text)["outline"]
        self.assertIn("# Page: Main", o)
        self.assertIn("Legend (colour meanings, already applied to boxes in [brackets]): Classical residual", o)
        self.assertIn("## Zone: DMZ (dashed border)", o)
        self.assertIn("- box [Classical residual]: Web server / nginx 1.18", o)
        self.assertIn("## Zone: Tier", o)          # a container with a child at relative coordinates
        self.assertIn("- box: Postgres", o)
        self.assertIn('- Web server -> Postgres  "SQL"', o)
        self.assertIn('- Postgres <-> Web server (dashed)  "replication"', o)  # label held as a child cell
        self.assertNotIn("Legend\n", o.split("Legend (")[1])                  # legend not listed as a box
        return o

    def test_plain(self):
        self.check(PLAIN)

    def test_compressed(self):
        self.check(compressed(MODEL))

    def test_drawio_svg(self):
        self.check(f'<svg xmlns="http://www.w3.org/2000/svg" content="{html.escape(PLAIN)}"><g/></svg>')

    def test_bare_graph_model(self):
        self.assertIn("# Page: Page 1", outline(MODEL)["outline"])

    def test_refuses_dtds_and_junk(self):
        with self.assertRaises(OutlineError):
            outline('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><mxfile/>')
        with self.assertRaises(OutlineError):
            outline("<svg xmlns='http://www.w3.org/2000/svg'/>")
        with self.assertRaises(OutlineError):
            outline("not xml")
        with self.assertRaises(OutlineError):
            outline("<html/>")



class DuplicateNames(unittest.TestCase):
    def test_arrows_name_boxes_with_shared_first_lines_unambiguously(self):
        m = """<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Scheduler&lt;br&gt;every 15 min" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="100" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="b" value="Scheduler&lt;br&gt;nightly" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="200" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="c" value="Workflow" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="300" y="150" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="e1" style="" edge="1" parent="1" source="a" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" style="" edge="1" parent="1" source="b" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>"""
        o = outline(m)["outline"]
        self.assertIn("- Scheduler (every 15 min) -> Workflow", o)
        self.assertIn("- Scheduler (nightly) -> Workflow", o)


if __name__ == "__main__":
    unittest.main()
