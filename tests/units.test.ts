import { describe, expect, it } from "vitest";
import { parseRobots } from "../src/fetch.js";
import { slugify } from "../src/run.js";
import { guardUrl } from "../src/ssrf.js";
import { normalizeUrl, urlHash } from "../src/url.js";
import { extractGapsQuestions, hasUrl, parsesAsMarkdown, validateProse } from "../src/validate.js";

// SSRF guard: literal addresses only here; DNS-based cases would hit the
// network. The engine tests cover resolution behavior.
const GUARD_LITERALS: readonly [string, boolean][] = [
  ["http://127.0.0.1/", false],
  ["http://10.0.0.1/", false],
  ["http://172.16.1.1/", false],
  ["http://192.168.1.1/", false],
  ["http://169.254.169.254/", false],
  ["http://100.64.1.1/", false],
  ["http://0.0.0.0/", false],
  ["http://[::1]/", false],
  ["http://[fe80::1]/", false],
  ["http://[fd12::1]/", false],
  ["http://[::ffff:127.0.0.1]/", false],
  ["http://foo.local/", false],
  ["http://localhost/", false],
  ["file:///etc/passwd", false],
  ["ftp://example.com/", false],
  ["http://example.com:8080/", false],
  ["https://1.1.1.1/", true],
];

describe("guardUrl literals", () => {
  for (const [url, expected] of GUARD_LITERALS) {
    it(`${expected ? "allows" : "refuses"} ${url}`, async () => {
      const verdict = await guardUrl(url);
      expect(verdict.allowed).toBe(expected);
    });
  }
});

describe("normalizeUrl", () => {
  it("lowercases scheme and host, strips fragment and tracking params", () => {
    expect(normalizeUrl("HTTPS://Example.COM/a?utm_source=x&keep=1#frag")).toBe(
      "https://example.com/a?keep=1",
    );
  });
  it("treats trailing slash on a bare host as equivalent", () => {
    expect(normalizeUrl("https://example.com/")).toBe(normalizeUrl("https://example.com"));
  });
  it("makes one normalized URL one document", () => {
    const a = normalizeUrl("https://example.com/a?utm_campaign=z&id=7");
    const b = normalizeUrl("https://example.com/a?id=7");
    expect(a).toBe(b);
    expect(urlHash(a)).toBe(urlHash(b));
  });
  it("keeps different params as different documents", () => {
    expect(normalizeUrl("https://example.com/a?x=1")).not.toBe(
      normalizeUrl("https://example.com/a?y=1"),
    );
  });
});

describe("parseRobots", () => {
  it("collects disallow rules for the star agent only", () => {
    const body =
      "User-agent: goog\nDisallow: /no\n\nUser-agent: *\nDisallow: /private\nDisallow: /tmp";
    expect(parseRobots(body)).toEqual(["/private", "/tmp"]);
  });
  it("ignores comments and blank rules", () => {
    expect(parseRobots("# comment\nUser-agent: *\nDisallow: \nDisallow: /a # trailing")).toEqual([
      "/a",
    ]);
  });
});

describe("validateProse", () => {
  it("accepts a minimal brief", () => {
    expect(validateProse("brief", "# Brief\n\nSome context.\n")).toEqual([]);
  });

  it("flags empty files", () => {
    expect(validateProse("brief", "   \n")).toHaveLength(1);
  });

  it("requires URLs on foundation and followup", () => {
    expect(validateProse("foundation", "# F\n\nText.\n")[0]).toContain("no URLs");
    expect(validateProse("followup", "# F\n\nText.\n")[0]).toContain("no URLs");
    expect(validateProse("brief", "# B\n\nText.\n")).toEqual([]);
  });

  it("detects URLs in markdown links and bare form", () => {
    expect(hasUrl("[label](https://example.com/x)")).toBe(true);
    expect(hasUrl("see https://example.com for more")).toBe(true);
    expect(hasUrl("no links here")).toBe(false);
  });

  it("parses ordinary markdown", () => {
    expect(parsesAsMarkdown("# Title\n\n- a\n- b\n")).toBe(true);
  });
});

describe("extractGapsQuestions", () => {
  it("reads a single fenced list", () => {
    const text = `# G\n\n\`\`\`json\n["a?", "b?"]\n\`\`\`\n`;
    const { errors, questions } = extractGapsQuestions(text);
    expect(errors).toEqual([]);
    expect(questions).toEqual(["a?", "b?"]);
  });

  it("requires exactly one block", () => {
    expect(extractGapsQuestions("no block").errors).toHaveLength(1);
    const two = '```json\n["a"]\n```\n\n```json\n["b"]\n```\n';
    expect(extractGapsQuestions(two).errors[0]).toContain("exactly one");
  });

  it("rejects non-array JSON", () => {
    const { errors } = extractGapsQuestions("```json\n{}\n```\n");
    expect(errors[0]).toContain("array");
  });

  it("rejects empty and blank questions", () => {
    expect(extractGapsQuestions("```json\n[]\n```\n").errors[0]).toContain("at least one");
    const { errors } = extractGapsQuestions('```json\n["ok?", "  "]\n```\n');
    expect(errors[0]).toContain("question 2");
  });
});

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Burnout in Early Childhood Educators!")).toBe(
      "burnout-in-early-childhood-educators",
    );
  });

  it("falls back for punctuation-only topics", () => {
    expect(slugify("!!!")).toBe("run");
  });
});
