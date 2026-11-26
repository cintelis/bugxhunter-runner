import { describe, expect, it } from "vitest";
import { TEXT_ACCEPT, isTextFile, looksBinary } from "./textAttach";

describe("text attachments", () => {
  it("accepts Markdown and plain text by extension, whatever type the browser reports", () => {
    for (const name of ["threat-model.md", "NOTES.MD", "design.markdown", "scope.txt"]) expect(isTextFile(name), name).toBe(true);
    expect(isTextFile("README", "text/markdown")).toBe(true);
    expect(isTextFile("notes", "text/plain")).toBe(true);
  });

  it("does not take other files for text", () => {
    for (const name of ["app.js", "report.pdf", "photo.png", "data.json", "page.html", "md", "notes.md.exe"]) expect(isTextFile(name), name).toBe(false);
    expect(isTextFile("page", "text/html")).toBe(false);
    expect(isTextFile("x", "application/octet-stream")).toBe(false);
  });

  it("spots a binary file with a text name", () => {
    expect(looksBinary("# Title\n\tindented\r\nline — ünïcode ✓")).toBe(false);
    expect(looksBinary("PK\u0003\u0004\u0000\u0000")).toBe(true);
    expect(looksBinary("")).toBe(false);
  });

  it("offers the extensions to the file picker", () => {
    expect(TEXT_ACCEPT.split(",")).toEqual(expect.arrayContaining([".md", ".markdown", ".txt"]));
  });
});
