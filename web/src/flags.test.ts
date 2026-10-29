import { describe, expect, it } from "vitest";
import { DEFAULT_FLAG_PATTERN, flagFragments, isValid, markFlags, setFlagPattern } from "./flags";

describe("flags", () => {
  it("marks the common flag shapes in text, never inside tags", () => {
    const html = '<p>Found picoCTF{s0_cl0se} and flag{a-b_c} in <a href="/x?flag{not}">a link</a></p>';
    const out = markFlags(html, DEFAULT_FLAG_PATTERN);
    expect(out).toContain('<mark class="flag">picoCTF{s0_cl0se}</mark>');
    expect(out).toContain('<mark class="flag">flag{a-b_c}</mark>');
    expect(out).toContain('href="/x?flag{not}"'); // attribute untouched
  });

  it("leaves code without braces and JSON-looking text alone", () => {
    expect(markFlags("<p>nothing here</p>")).toBe("<p>nothing here</p>");
    expect(markFlags('<pre>{"a": 1}</pre>', DEFAULT_FLAG_PATTERN)).toBe('<pre>{"a": 1}</pre>');
    expect(markFlags("<p>if (x) { return y; }</p>", DEFAULT_FLAG_PATTERN)).toBe("<p>if (x) { return y; }</p>");
  });

  it("splits plain text into fragments with flags at odd indexes", () => {
    expect(flagFragments("ok HTB{one} and CTF{two}.", DEFAULT_FLAG_PATTERN)).toEqual(["ok ", "HTB{one}", " and ", "CTF{two}", "."]);
    expect(flagFragments("no flag", DEFAULT_FLAG_PATTERN)).toEqual(["no flag"]);
  });

  it("accepts a custom pattern and falls back to the default on a bad one", () => {
    expect(setFlagPattern("ACME-[0-9]{4}")).toBe("ACME-[0-9]{4}");
    expect(flagFragments("see ACME-1234 now")).toEqual(["see ", "ACME-1234", " now"]);
    expect(isValid("(")).toBe(false);
    expect(setFlagPattern("(")).toBe(DEFAULT_FLAG_PATTERN);
    expect(setFlagPattern("")).toBe(DEFAULT_FLAG_PATTERN);
  });
});
