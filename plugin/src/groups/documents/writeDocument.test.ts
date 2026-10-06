import { existsSync } from "fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { createServer, type Server } from "http";
import { type AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../shared/errors";
import { writeMode } from "../../shared/mode";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { decodeEntities, isSafeLink } from "./lib/markdown";
import { extractPdfText } from "./lib/pdf";
import { markdownToDocxBuffer } from "./lib/writeDocx";
import { htmlToPdfBuffer, markdownToPrintHtml } from "./lib/writePdf";
import { toolsProvider } from "./toolsProvider";

/** The installed browser the PDF tests can print with, if there is one. */
const browserChannel = (() => {
  const installed = (paths: string[]) => paths.some(path => existsSync(path));
  const edge = installed([
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/opt/microsoft/msedge/msedge",
  ]);
  const chrome = installed([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/google/chrome/chrome",
  ]);
  return edge ? "msedge" : chrome ? "chrome" : null;
})();

// A local server that only records what is asked of it: nothing a document holds may reach it.
let server: Server;
let base: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("x");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

let root: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "write-doc-root-"));
  work = await mkdtemp(join(tmpdir(), "write-doc-work-"));
  requests.length = 0;
});

afterEach(async () => {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
  await rm(root, options).catch(() => {});
  await rm(work, options).catch(() => {});
});

const sample = () =>
  [
    "# Report Title",
    "",
    "Some **bold words**, *slanted words*, ~~struck words~~, `inline_code` and [the site](https://example.com/page).",
    "",
    "- apple",
    "- pear",
    "  - nested pear",
    "",
    "3. first step",
    "4. second step",
    "",
    "| Name | Qty |",
    "|------|----:|",
    "| Widget | 42 |",
    "",
    "```js",
    "const a = 1;",
    "  indented();",
    "```",
    "",
    "> quoted words",
    "",
    "---",
    "",
    `![a chart](${base}/chart.png)`,
    "",
    '<script>alert("x")</script>',
    "",
    "AT&amp;T line one  ",
    "line two [bad](javascript:alert(1))",
    "",
    "###### Smallest heading",
  ].join("\n");

async function unzipDocx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = (name: string) => zip.file(name)!.async("string");
  return {
    names: Object.keys(zip.files),
    document: await read("word/document.xml"),
    relationships: await read("word/_rels/document.xml.rels"),
    numbering: await read("word/numbering.xml"),
  };
}

/** The XML of the paragraph that holds `text`. */
function paragraphWith(xml: string, text: string): string {
  const found = xml.split("</w:p>").find(paragraph => paragraph.includes(text));
  if (!found) throw new Error(`No paragraph contains "${text}"`);
  return found.slice(found.lastIndexOf("<w:p>") >= 0 ? found.lastIndexOf("<w:p>") : 0);
}

/** The XML of the run that holds `text`. */
function runWith(xml: string, text: string): string {
  const found = xml.split("</w:r>").find(run => run.includes(text));
  if (!found) throw new Error(`No run contains "${text}"`);
  return found.slice(found.lastIndexOf("<w:r>"));
}

describe("markdown helpers", () => {
  it("only lets web and mail links become hyperlinks", () => {
    expect(isSafeLink("https://example.com")).toBe(true);
    expect(isSafeLink("mailto:someone@example.com")).toBe(true);
    for (const href of ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,x", "notes.md", "", null]) {
      expect(isSafeLink(href)).toBe(false);
    }
  });

  it("decodes character references", () => {
    expect(decodeEntities("AT&amp;T &lt;b&gt; &#169; &#x41; &nosuch; &#0;")).toBe("AT&T <b> \u00a9 A &nosuch; &#0;");
  });
});

describe("markdownToDocxBuffer", () => {
  it("writes headings, inline styles, links, lists, tables, code and quotes", async () => {
    const { buffer, omittedImages } = await markdownToDocxBuffer(sample());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const { document, relationships, numbering } = await unzipDocx(buffer);

    expect(paragraphWith(document, "Report Title")).toContain('<w:pStyle w:val="Heading1"/>');
    expect(paragraphWith(document, "Smallest heading")).toContain('<w:pStyle w:val="Heading6"/>');

    expect(runWith(document, "bold words")).toMatch(/<w:b\/>/);
    expect(runWith(document, "slanted words")).toMatch(/<w:i\/>/);
    expect(runWith(document, "struck words")).toMatch(/<w:strike\/>/);
    expect(runWith(document, "inline_code")).toContain("Consolas");
    expect(runWith(document, "Some ")).not.toMatch(/<w:b\/>|<w:i\/>|Consolas/);

    expect(document).toMatch(/<w:hyperlink [^>]*r:id="[^"]+"[^>]*>(?:(?!<\/w:hyperlink>).)*the site/);
    expect(relationships).toContain('Target="https://example.com/page"');
    expect(relationships).toContain('TargetMode="External"');

    for (const item of ["apple", "pear", "nested pear", "first step", "second step"]) {
      expect(paragraphWith(document, item)).toContain("<w:numPr>");
    }
    expect(paragraphWith(document, "apple")).toContain('<w:ilvl w:val="0"/>');
    expect(paragraphWith(document, "nested pear")).toContain('<w:ilvl w:val="1"/>');
    // The ordered list keeps the number it starts at.
    expect(numbering).toContain('<w:start w:val="3"/>');

    expect(document).toContain("<w:tbl>");
    expect(runWith(document, "Name")).toMatch(/<w:b\/>/);
    expect(runWith(document, "Widget")).not.toMatch(/<w:b\/>/);
    expect(document).toContain(">42</w:t>");

    const code = paragraphWith(document, "const a = 1;");
    expect(code).toContain("Consolas");
    expect(code).toMatch(/<w:br\/>(?:(?!<\/w:r>).)*<w:t xml:space="preserve"> {2}indented\(\);<\/w:t>/);

    expect(paragraphWith(document, "quoted words")).toMatch(/<w:ind [^>]*w:left="720"/);
    expect(document).toMatch(/<w:pBdr><w:bottom /); // the horizontal rule

    expect(paragraphWith(document, "line two")).toMatch(/AT&amp;T line one<\/w:t>(?:(?!<\/w:p>).)*<w:br\/>/);
    // An unsafe link keeps its text and loses the link.
    expect(document).toContain(">bad</w:t>");
    expect(relationships).not.toContain("javascript:");
    expect(omittedImages).toBe(1);
  });

  it("leaves images out, counts them, and writes raw HTML as literal text", async () => {
    const markdown = `![a chart](${base}/chart.png) and ![](${base}/unnamed.png)\n\n<script>alert("x")</script>\n\ninline <b>tag</b> <img src="${base}/raw.png">`;
    const { buffer, omittedImages } = await markdownToDocxBuffer(markdown);
    const { document, names, relationships } = await unzipDocx(buffer);

    expect(omittedImages).toBe(3);
    expect(document).toContain("[a chart]");
    expect(document).toContain("[image]");
    expect(document).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(document).toContain("&lt;b&gt;");
    expect(document).not.toContain("<w:drawing>");
    expect(names.filter(name => name.startsWith("word/media/"))).toEqual([]);
    expect(relationships).not.toContain("127.0.0.1");
    expect(requests).toEqual([]);
  });

  it("handles task lists, content inside list items, and an empty document", async () => {
    const { buffer } = await markdownToDocxBuffer("- [x] done\n- [ ] todo\n\n1. step\n\n   more detail\n\n   ```\n   run it\n   ```\n");
    const { document } = await unzipDocx(buffer);
    expect(paragraphWith(document, "done")).toContain("\u2612");
    expect(paragraphWith(document, "todo")).toContain("\u2610");
    expect(paragraphWith(document, "step")).toContain("<w:numPr>");
    expect(paragraphWith(document, "more detail")).not.toContain("<w:numPr>");
    expect(paragraphWith(document, "more detail")).toMatch(/<w:ind [^>]*w:left="720"/);
    expect(paragraphWith(document, "run it")).toContain("Consolas");

    const empty = await unzipDocx((await markdownToDocxBuffer("")).buffer);
    expect(empty.document).toContain("<w:p");
  });
});

describe("markdownToPrintHtml", () => {
  it("renders tables, code and links, and escapes raw HTML", async () => {
    const { html, omittedImages } = await markdownToPrintHtml(sample(), "My <Report>");
    const body = html.slice(html.indexOf("<body>"));

    expect(html).toContain("<title>My &lt;Report&gt;</title>");
    expect(html).toContain("Content-Security-Policy");
    expect(body).toContain("<h1>Report Title</h1>");
    expect(body).toContain("<strong>bold words</strong>");
    expect(body).toMatch(/<table>[\s\S]*<th>Name<\/th>[\s\S]*<td>Widget<\/td>[\s\S]*<\/table>/);
    expect(body).toMatch(/<pre><code class="language-js">const a = 1;\n {2}indented\(\);\n<\/code><\/pre>/);
    expect(body).toContain('<a href="https://example.com/page">the site</a>');
    expect(body).toContain("AT&amp;T line one<br>");

    expect(body).not.toMatch(/<script/i);
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).not.toContain("javascript:");
    expect(body).toContain("bad");

    expect(omittedImages).toBe(1);
    expect(body).toContain("[a chart]");
    expect(body).not.toMatch(/<img/i);
    expect(body).not.toContain("127.0.0.1");
  });

  it("lets no markup through, inline or in a block", async () => {
    const markdown = [
      `text <img src="${base}/inline.png" onerror="alert(1)"> more`,
      "",
      `<div><iframe src="${base}/frame"></iframe>`,
      `<link rel="stylesheet" href="${base}/style.css">`,
      "</div>",
      "",
      "<script>if (a<b) fetch('/x')</script>",
      "",
      `<style>body { background: url(${base}/bg.png) }</style>`,
      "",
      `[![badge](${base}/badge.png)](https://example.com)`,
    ].join("\n");
    const { html, omittedImages } = await markdownToPrintHtml(markdown);
    const body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
    const tags = new Set([...body.matchAll(/<\/?([a-z0-9]+)/gi)].map(match => match[1].toLowerCase()));
    expect([...tags].sort()).toEqual(["a", "p", "pre"]);
    // The only attributes left are the ones the converter writes itself.
    expect([...body.matchAll(/<[a-z0-9]+\s+([^>]*)>/gi)].map(match => match[1]).sort()).toEqual(['class="raw-html"', 'class="raw-html"', 'class="raw-html"', 'href="https://example.com"']);
    expect(omittedImages).toBe(2);
    expect(body).toContain('<a href="https://example.com">[badge]</a>');
  });
});

describe("htmlToPdfBuffer", () => {
  it("says what PDF output needs when the browser cannot be started", async () => {
    const launch = async () => {
      throw new Error("Executable doesn't exist at C:\\nowhere\nmore detail");
    };
    const failure = await htmlToPdfBuffer("<p>hi</p>", "msedge", { launch }).catch(error => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure.message).toMatch(/PDF output needs Edge or Chrome installed.*\(msedge\).*Executable doesn't exist at C:\\nowhere\. Write a \.docx instead/);
    expect(failure.message).not.toContain("more detail");
  });

  it.runIf(browserChannel)(
    "prints a PDF whose text can be read back",
    async () => {
      const { html } = await markdownToPrintHtml("# Quarterly Zebra Report\n\nRevenue rose **sharply**.\n\n| Region | Total |\n|---|---|\n| North | 1234 |\n\n```\ncode_sample_line\n```\n");
      const pdf = await htmlToPdfBuffer(html, browserChannel!);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const file = join(root, "out.pdf");
      await writeFile(file, pdf);
      const result = await extractPdfText(file);
      const text = result.pages.map(page => page.text).join("\n");
      expect(result.totalPages).toBe(1);
      expect(result.looksScanned).toBe(false);
      for (const expected of ["Quarterly Zebra Report", "Revenue rose", "sharply", "North", "1234", "code_sample_line"]) {
        expect(text).toContain(expected);
      }
    },
    60_000,
  );

  it.runIf(browserChannel)(
    "makes no request and runs no script, even for hostile HTML",
    async () => {
      // What the converter would never produce: the browser itself must refuse it too.
      const hostile =
        `<html><head><link rel="stylesheet" href="${base}/style.css"><style>body { background: url(${base}/bg.png) }</style></head>` +
        `<body><p>Still printed</p><img src="${base}/direct.png"><iframe src="${base}/frame"></iframe>` +
        `<script src="${base}/remote.js"></script><script>fetch("${base}/fetched"); document.body.innerHTML = "REPLACED"</script></body></html>`;
      const pdf = await htmlToPdfBuffer(hostile, browserChannel!);
      const file = join(root, "hostile.pdf");
      await writeFile(file, pdf);
      const text = (await extractPdfText(file)).pages.map(page => page.text).join("\n");
      expect(text).toContain("Still printed");
      expect(text).not.toContain("REPLACED");
      expect(requests).toEqual([]);
    },
    60_000,
  );
});

describe("write_document tool", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    projectFolder: root,
    visionModel: "",
    renderScale: 1,
    maxPages: 10,
    maxOutputChars: 20000,
    browserChannel: browserChannel ?? "msedge",
    ...overrides,
  });
  const provider = (overrides: Record<string, unknown> = {}) =>
    toolsProvider(fakeController({ config: config(overrides), workingDirectory: work }));
  const write = async (params: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    callTool(await provider(overrides), "write_document", params);

  it("writes a Word file, creating parent folders and leaving no temporary file", async () => {
    const output = await write({ path: "reports/2026/summary.docx", content: `# Summary\n\nAll good.\n\n![logo](${base}/logo.png)` });
    expect(output).toMatch(/^Created reports\/2026\/summary\.docx \(Word, \d+(\.\d)? KB\)\. 1 image was left out/);
    expect(await readdir(join(root, "reports", "2026"))).toEqual(["summary.docx"]);
    const { document } = await unzipDocx(await readFile(join(root, "reports", "2026", "summary.docx")));
    expect(document).toContain("Summary");
    expect(document).toContain("[logo]");
    expect(requests).toEqual([]);
  });

  it("says nothing about images when there are none", async () => {
    expect(await write({ path: "plain.docx", content: "Just text." })).toMatch(/^Created plain\.docx \(Word, [\d.]+ KB\)\.$/);
  });

  it("refuses other extensions and points at write_file", async () => {
    for (const path of ["notes.md", "table.csv", "page.html", "report", "report.doc"]) {
      expect(await write({ path, content: "# Hi" })).toMatch(/^Error: .*\.docx.*\.pdf.*use write_file/);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses paths outside the project folder, directories and empty content", async () => {
    expect(await write({ path: "../outside.docx", content: "# Hi" })).toMatch(/^Error: .*outside the allowed root/);
    expect(await write({ path: join(work, "elsewhere.pdf"), content: "# Hi" })).toMatch(/^Error: .*outside the allowed root/);
    expect(existsSync(join(root, "..", "outside.docx"))).toBe(false);
    expect(await write({ path: "empty.docx", content: "  \n" })).toMatch(/^Error: content is empty/);
    expect(await readdir(root)).toEqual([]);
  });

  it("replaces an existing file only with overwrite", async () => {
    const file = join(root, "report.docx");
    await writeFile(file, "the user's own document");

    expect(await write({ path: "report.docx", content: "# New" })).toMatch(/^Error: report\.docx already exists\. Pass overwrite: true/);
    expect(await write({ path: "report.docx", content: "# New", overwrite: false })).toMatch(/^Error: report\.docx already exists/);
    expect(await readFile(file, "utf-8")).toBe("the user's own document");

    expect(await write({ path: "report.docx", content: "# New", overwrite: true })).toMatch(/^Overwrote report\.docx \(Word/);
    expect((await unzipDocx(await readFile(file))).document).toContain("New");
    expect(await readdir(root)).toEqual(["report.docx"]);
  });

  it("returns the browser error for a PDF when the browser cannot be started, and writes nothing", async () => {
    const output = await write({ path: "out/report.pdf", content: "# Hi" }, { browserChannel: "no-such-browser" });
    expect(output).toMatch(/^Error: PDF output needs Edge or Chrome installed.*\(no-such-browser\).*Write a \.docx instead/);
    expect(await readdir(root)).toEqual([]);
  });

  it("is withheld while planning", async () => {
    expect((await provider()).map(tool => tool.name)).toContain("write_document");
    await writeMode(work, { planning: true });
    const names = (await provider()).map(tool => tool.name);
    expect(names).not.toContain("write_document");
    expect(names).toContain("read_document_text");
  });

  it.runIf(browserChannel)(
    "writes a PDF that reads back, without fetching the images it mentions",
    async () => {
      const content = `# Field Notes\n\nThe heron stood still.\n\n![photo](${base}/photo.png)\n\n<img src="${base}/raw.png">\n`;
      const output = await write({ path: "notes/field.pdf", content });
      expect(output).toMatch(/^Created notes\/field\.pdf \(PDF, [\d.]+ KB\)\. 2 images were left out/);
      expect(await readdir(join(root, "notes"))).toEqual(["field.pdf"]);

      const read = await callTool(await provider(), "read_document_text", { path: "notes/field.pdf" });
      expect(read).toContain("Field Notes");
      expect(read).toContain("The heron stood still.");
      expect(read).toContain("[photo]");
      expect(read).not.toContain("probably scanned");
      expect(requests).toEqual([]);
    },
    60_000,
  );
});
