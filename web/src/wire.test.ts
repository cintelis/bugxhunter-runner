import { describe, expect, it } from "vitest";
import { userContent, withDocs } from "./wire";

const doc = { name: "zones.drawio", text: "# Page: Trust Zones\n- box: HSM\n" };

describe("withDocs", () => {
  it("leaves text alone without diagrams", () => {
    expect(withDocs("hi")).toBe("hi");
    expect(withDocs(null)).toBeNull();
  });
  it("appends each outline in a named block, with a default ask when the text is empty", () => {
    const t = withDocs("", [doc])!;
    expect(t.startsWith("Review this diagram for security issues.")).toBe(true);
    expect(t).toContain('<diagram file="zones.drawio">\n# Page: Trust Zones\n- box: HSM\n</diagram>');
    expect(withDocs("Check the HSM", [doc])!.startsWith("Check the HSM\n\nAttached draw.io diagram")).toBe(true);
  });
});

describe("withDocs and text files", () => {
  const notes = { name: 'design "v2".md', text: "# Login\n- tokens never expire\n", kind: "text" as const };
  it("sends a Markdown or text file in full, in a named block", () => {
    const t = withDocs("Threat-model this", [notes])!;
    expect(t.startsWith('Threat-model this\n\nAttached file "design "v2".md", in full:')).toBe(true);
    expect(t).toContain("<file name=\"design 'v2'.md\">\n# Login\n- tokens never expire\n</file>");
    expect(t).not.toContain("<diagram");
  });
  it("asks for a document review when only text files are attached, a diagram review otherwise", () => {
    expect(withDocs("", [notes])!.startsWith("Review this document for security issues.")).toBe(true);
    expect(withDocs(null, [notes, doc])!.startsWith("Review this diagram for security issues.")).toBe(true);
  });
});

describe("userContent", () => {
  it("puts outlines in the text part next to images", () => {
    const c = userContent("Look", [{ name: "a.png", url: "data:image/png;base64,AA" }], [doc]) as { type: string; text?: string }[];
    expect(c[0].type).toBe("text");
    expect(c[0].text).toContain("<diagram file=\"zones.drawio\">");
    expect(c[1].type).toBe("image_url");
  });
});
