import { describe, expect, it } from "vitest";
import { linkFilePaths } from "./filelinks";

const docker = ["/workspace"];
const local = ["C:\\Users\\nick\\bugxhunter\\repos\\acme\\app"];

describe("linkFilePaths", () => {
  it("links a Docker workspace path in prose and keeps trailing punctuation outside", () => {
    const out = linkFilePaths("<p>Saved as /workspace/acme/app/analysis.md.</p>", docker, "/workspace/acme/app");
    expect(out).toBe('<p>Saved as <a class="file-link" href="/api/agent/file?directory=%2Fworkspace%2Facme%2Fapp&path=%2Fworkspace%2Facme%2Fapp%2Fanalysis.md" download title="Download /workspace/acme/app/analysis.md">/workspace/acme/app/analysis.md</a>.</p>');
  });
  it("links inside code spans and a Windows project path", () => {
    const out = linkFilePaths("<p>Report: <code>C:\\Users\\nick\\bugxhunter\\repos\\acme\\app\\out\\report.html</code></p>", local, local[0]);
    expect(out).toContain('<code><a class="file-link" href="/api/agent/file?directory=');
    expect(out).toContain("path=C%3A%5CUsers%5Cnick%5Cbugxhunter%5Crepos%5Cacme%5Capp%5Cout%5Creport.html");
  });
  it("leaves folders, other roots and existing links alone", () => {
    expect(linkFilePaths("<p>cd /workspace/acme/app and /etc/passwd.txt</p>", docker, "/workspace/acme/app")).toBe("<p>cd /workspace/acme/app and /etc/passwd.txt</p>");
    const linked = '<p><a href="https://x.y/">/workspace/a/b.md</a></p>';
    expect(linkFilePaths(linked, docker, "/workspace/a")).toBe(linked);
  });
  it("does nothing without roots", () => {
    expect(linkFilePaths("<p>/workspace/a/b.md</p>", [], "")).toBe("<p>/workspace/a/b.md</p>");
  });
});
