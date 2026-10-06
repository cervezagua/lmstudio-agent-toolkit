import { readFileSync } from "fs";
import { createServer, type Server } from "http";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, fakeController } from "../../../plugin/src/shared/testing/fake-controller";
import { toolsProvider } from "./toolsProvider";

const ARTICLE = `<!doctype html><html><head><title>Widgets</title></head><body><nav><a href="/home">Home</a></nav>
<article><h1>Understanding Widgets</h1><p>${"Widgets are small components that do one thing well. ".repeat(12)}</p>
<p>Read the <a href="/docs/guide">guide</a>.</p>
<table id="prices"><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$5</td></tr></table></article></body></html>`;

/** A valid one-page PDF containing the given text. */
function makePdf(content: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${content}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    switch (req.url) {
      case "/article":
        return send(200, "text/html; charset=utf-8", ARTICLE);
      case "/empty-js":
        return send(200, "text/html", "<html><head><title>App</title></head><body><div id=root></div></body></html>");
      case "/long":
        return send(200, "text/plain", "ABCDEFGHIJ".repeat(200)); // 2000 characters
      case "/doc.pdf":
        return send(200, "application/pdf", makePdf("Quarterly report text"));
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

// Imports the plugin as LM Studio would, so it only passes once `npm run sync-standalone` has copied
// in the agent-toolkit files listed in files.json.
describe("page-reader plugin", () => {
  const tools = (maxChars = 15000) => toolsProvider(fakeController({ config: { maxChars }, workingDirectory: "." }));

  it("offers fetch_url and nothing else, without promising a browser", async () => {
    const offered = await tools();
    expect(offered.map(t => t.name)).toEqual(["fetch_url"]);
    expect(offered[0].description).not.toMatch(/browser/i);
  });

  it("reads a page as markdown, then serves it from the cache", async () => {
    const page = String(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/article` }));
    expect(page.startsWith(`URL: ${baseUrl}/article\nTitle: Widgets\n\n`)).toBe(true);
    expect(page).toContain("Widgets are small components");
    expect(page).toContain(`[guide](${baseUrl}/docs/guide)`);
    expect(page).not.toContain("Home");
    expect(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/article` })).toContain("From cache (pass refresh to fetch again)");
    expect(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/article`, refresh: true })).not.toContain("From cache");
  });

  it("returns only what selector matches", async () => {
    const part = String(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/article`, selector: "table#prices" }));
    expect(part).toContain('(1 element matching "table#prices")');
    expect(part).toContain("Basic");
    expect(part).not.toContain("Widgets are small components");
    expect(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/article`, selector: ".absent" })).toMatch(/^Error: Nothing on .* matches/);
  });

  it("cuts a long document at the Max Characters setting and continues with offset", async () => {
    const first = String(await callTool(await tools(1000), "fetch_url", { url: `${baseUrl}/long` }));
    expect(first).toContain("[1000 characters left; call again with offset 1000]");
    const rest = String(await callTool(await tools(1000), "fetch_url", { url: `${baseUrl}/long`, offset: 1000 }));
    expect(rest).not.toContain("characters left");
  });

  it("reads a PDF with the plugin's own dependencies", async () => {
    const pdf = String(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/doc.pdf` }));
    expect(pdf).toContain("Type: PDF");
    expect(pdf).toContain("Quarterly report text");
  });

  it("says a nearly empty page probably needs JavaScript, and starts no browser", async () => {
    const result = String(await callTool(await tools(), "fetch_url", { url: `${baseUrl}/empty-js` }));
    expect(result).toMatch(/probably needs JavaScript, which this plugin does not run/);
    expect(result).not.toContain("rendered in the browser");
    // Nothing the plugin ships can start one: no copied file or dependency is a browser.
    const { files } = JSON.parse(readFileSync(join(__dirname, "..", "files.json"), "utf-8"));
    expect(files.filter((file: string) => /browser/i.test(file))).toEqual([]);
    for (const file of files) expect(readFileSync(join(__dirname, file), "utf-8")).not.toMatch(/playwright|\/browser"|\/config"/);
    const { dependencies } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    expect(Object.keys(dependencies).sort()).toEqual(["@lmstudio/sdk", "@mozilla/readability", "linkedom", "turndown", "unpdf", "zod"]);
  });

  it("refuses anything that is not an http or https URL", async () => {
    expect(await callTool(await tools(), "fetch_url", { url: "file:///etc/hosts" })).toBe("Error: Only http and https URLs can be fetched.");
  });
});
