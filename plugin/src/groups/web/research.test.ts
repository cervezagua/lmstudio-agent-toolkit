import { describe, expect, it } from "vitest";
import { ToolError } from "../../shared/errors";
import { checkCitations, interleave, keywords, parseQueries, research, withoutThinking, type ResearchDeps } from "./lib/research";

const page = (words: string) => `${words} `.repeat(60);

/** A fake model that answers each of research's three kinds of question from a script. */
function deps(overrides: Partial<ResearchDeps> & { notes?: Record<string, string>; answer?: string; queries?: string } = {}): ResearchDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (system, prompt) => {
      asked.push(prompt);
      if (system.includes("search queries")) return overrides.queries ?? "solar panel lifespan\nsolar panel degradation rate";
      if (system.includes("one web page")) {
        const url = /\((https?:[^)]+)\)/.exec(prompt)![1];
        return overrides.notes?.[url] ?? "NONE";
      }
      return overrides.answer ?? "Panels last 25 to 30 years [1]. They lose about 0.5% a year [2].";
    },
    search: async query =>
      query.includes("degradation")
        ? [{ title: "Degradation", url: "https://b.example/rate", snippet: "" }]
        : [
            { title: "Lifespan", url: "https://a.example/life", snippet: "" },
            { title: "Same page again", url: "https://www.a.example/life/", snippet: "" },
          ],
    fetch: async url => ({ title: `Title of ${url}`, text: page("solar") }),
    ...overrides,
  };
}

const twoSources = {
  "https://a.example/life": "- Panels last 25 to 30 years",
  "https://b.example/rate": "- Output drops about 0.5% a year",
};

describe("research", () => {
  it("searches, takes notes from each page and answers with numbered, checked sources", async () => {
    const d = deps({ notes: twoSources });
    const report = await research("How long do solar panels last?", d);
    expect(report).toContain("Panels last 25 to 30 years [1]. They lose about 0.5% a year [2].");
    expect(report).toContain("[1] Title of https://a.example/life - https://a.example/life");
    expect(report).toContain("[2] Title of https://b.example/rate - https://b.example/rate");
    expect(report).toContain('Searched: "solar panel lifespan", "solar panel degradation rate". Pages read: 2.');
    // The same page found twice is read once.
    expect(d.asked.filter(p => p.includes("<page>") && p.includes("a.example/life"))).toHaveLength(1);
    // The answer is written from the notes, not from the pages.
    expect(d.asked.at(-1)).toContain("[2] Title of https://b.example/rate\n- Output drops about 0.5% a year");
  });

  it("leaves out pages with nothing on the question, and renumbers what is left", async () => {
    const report = await research("q?", deps({ notes: { "https://b.example/rate": "- 0.5% a year" }, answer: "About 0.5% a year [1]." }));
    expect(report).toContain("[1] Title of https://b.example/rate");
    expect(report).not.toContain("a.example");
  });

  it("removes citations of sources that do not exist, and says so", async () => {
    const report = await research("q?", deps({ notes: twoSources, answer: "Long [1]. Slow [2][7]. Odd [9]." }));
    expect(report).toContain("Long [1]. Slow [2]. Odd.");
    expect(report).toContain("2 citation(s) of sources that do not exist were removed");
  });

  it("warns when the answer cites nothing", async () => {
    const report = await research("q?", deps({ notes: twoSources, answer: "They last a long time." }));
    expect(report).toContain("cites none of the sources");
  });

  it("marks sources the answer does not cite", async () => {
    const report = await research("q?", deps({ notes: twoSources, answer: "Long [1]." }));
    expect(report).toContain("https://b.example/rate (not cited)");
    expect(report).not.toContain("https://a.example/life (not cited)");
  });

  it("skips pages that fail or have almost no text, and tries the next result", async () => {
    const d = deps({
      notes: { "https://b.example/rate": "- 0.5% a year" },
      answer: "x [1].",
      fetch: async url => {
        if (url.includes("a.example")) throw new ToolError("HTTP 403");
        return { title: "B", text: page("rate") };
      },
    });
    const report = await research("q?", d);
    expect(report).toContain("[1] B - https://b.example/rate");
    expect(report).toContain("Pages read: 1.");
  });

  it("says so when no page helps, without asking for an answer", async () => {
    const d = deps();
    const report = await research("q?", d);
    expect(report).toMatch(/^None of the pages read had anything on the question/);
    expect(d.asked.some(p => p.includes("Notes:"))).toBe(false);
  });

  it("reports failed searches as a recoverable error", async () => {
    const failing = deps({
      search: async () => {
        throw new ToolError("SearXNG is not reachable.");
      },
    });
    await expect(research("q?", failing)).rejects.toThrow(/searches failed: SearXNG is not reachable\. Run web_doctor/);
  });

  it("searches the question's keywords when the model writes no queries", async () => {
    const searched: string[] = [];
    const d = deps({ queries: "", search: async q => (searched.push(q), []) });
    await expect(research("What is the boiling point of water?", d)).rejects.toThrow(ToolError);
    expect(searched).toEqual(["the boiling point of water"]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const d = deps({ notes: twoSources, signal: controller.signal });
    const ask = d.ask;
    d.ask = async (system, prompt, max) => {
      if (system.includes("one web page")) controller.abort();
      return ask(system, prompt, max);
    };
    await expect(research("q?", d)).rejects.toThrow("Research was stopped.");
  });

  it("reads no more pages than asked", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `${i}`, url: `https://site${i}.example/`, snippet: "" }));
    const fetched: string[] = [];
    await research("q?", deps({ search: async () => many, fetch: async url => (fetched.push(url), { title: url, text: page("words") }) }), { maxSources: 3 });
    expect(fetched).toHaveLength(3);
  });
});

describe("research helpers", () => {
  it("cleans the model's queries", () => {
    expect(parseQueries('<think>hmm</think>\n1. "first query"\n- second query\n* First Query\n\nthird\nfourth', "q")).toEqual([
      "first query",
      "second query",
      "third",
    ]);
  });

  it("turns a question into keywords", () => {
    expect(keywords("How long do solar panels last?")).toBe("long do solar panels last");
    expect(keywords("?")).toBe("?");
  });

  it("takes results from each query in turn, once each", () => {
    const a = [
      { title: "", url: "https://x.example/1", snippet: "" },
      { title: "", url: "https://x.example/2", snippet: "" },
    ];
    const b = [
      { title: "", url: "http://www.x.example/1#top", snippet: "" },
      { title: "", url: "ftp://x.example/3", snippet: "" },
      { title: "", url: "https://x.example/4", snippet: "" },
    ];
    expect(interleave([a, b]).map(r => r.url)).toEqual(["https://x.example/1", "https://x.example/2", "https://x.example/4"]);
  });

  it("checks citations, including lists", () => {
    expect(checkCitations("A [1, 3]. B [4] .", 3)).toEqual({ answer: "A [1][3]. B.", cited: [1, 3], removed: 1 });
  });

  it("removes a reasoning model's thinking, even when it never closed", () => {
    expect(withoutThinking("<think>a</think>answer")).toBe("answer");
    expect(withoutThinking("<think>cut off")).toBe("");
  });
});
