import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createServer, type Server } from "http";
import { type AddressInfo } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../shared/errors";
import { callTool, fakeController } from "../../shared/testing/fake-controller";
import { USER_AGENT } from "../../shared/userAgent";
import {
  buildViewPrompt,
  DEFAULT_VIEW_PROMPT,
  extensionForContentType,
  looksLikeUrl,
  parseImageUrl,
  withDownloadedImage,
} from "./lib/viewImage";
import { toolsProvider } from "./toolsProvider";

// A 1x1 PNG: the fake vision model never decodes it, it only has to be a real file.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let server: Server;
let base: string;
const requests: { url: string; userAgent: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", userAgent: String(request.headers["user-agent"] ?? "") });
    const send = (type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
      response.writeHead(200, { "Content-Type": type, ...headers });
      response.end(body);
    };
    switch (request.url) {
      case "/cat.png":
        return send("image/png", PNG);
      case "/photo":
        return send("image/jpeg; charset=binary", PNG);
      case "/moved":
        response.writeHead(302, { Location: "/cat.png" });
        return response.end();
      case "/page":
        return send("text/html", "<html><body>not a picture</body></html>");
      case "/drawing.svg":
        return send("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>");
      case "/big.png":
        // Chunked, so there is no Content-Length to give the size away.
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(Buffer.alloc(3000, 1));
        return response.end(Buffer.alloc(3000, 2));
      case "/declared-big.png":
        return send("image/png", Buffer.alloc(5000, 1));
      case "/slow.png":
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(PNG.subarray(0, 10));
        return; // never finishes; the client gives up
      default:
        response.writeHead(404, { "Content-Type": "text/plain" });
        return response.end("no such thing");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

describe("view_image prompts and URL checks", () => {
  it("asks for a thorough description by default", () => {
    expect(buildViewPrompt()).toBe(DEFAULT_VIEW_PROMPT);
    expect(buildViewPrompt("   ")).toBe(DEFAULT_VIEW_PROMPT);
    expect(DEFAULT_VIEW_PROMPT).toMatch(/visible text/);
    expect(DEFAULT_VIEW_PROMPT).toMatch(/layout/);
    expect(DEFAULT_VIEW_PROMPT).toMatch(/colours/);
  });

  it("puts the question in the prompt and asks for honesty when the image does not show it", () => {
    const prompt = buildViewPrompt("  What colour is the button? ");
    expect(prompt).toContain("Question: What colour is the button?");
    expect(prompt).toMatch(/does not show the answer, say so plainly/);
    expect(prompt).not.toContain(DEFAULT_VIEW_PROMPT);
  });

  it("tells URLs from paths", () => {
    expect(looksLikeUrl("https://example.com/a.png")).toBe(true);
    expect(looksLikeUrl("ftp://example.com/a.png")).toBe(true);
    expect(looksLikeUrl("C:\\pictures\\a.png")).toBe(false);
    expect(looksLikeUrl("shots/a.png")).toBe(false);
  });

  it("maps content types to extensions and rejects the rest", () => {
    expect(extensionForContentType("image/png")).toBe(".png");
    expect(extensionForContentType("IMAGE/JPEG; charset=binary")).toBe(".jpg");
    expect(extensionForContentType("image/webp")).toBe(".webp");
    expect(extensionForContentType("image/gif")).toBe(".gif");
    expect(extensionForContentType("image/bmp")).toBe(".bmp");
    expect(extensionForContentType("image/svg+xml")).toBeNull();
    expect(extensionForContentType("text/html")).toBeNull();
    expect(extensionForContentType("")).toBeNull();
  });

  it("refuses other schemes, credentials and nonsense", () => {
    expect(() => parseImageUrl("ftp://example.com/a.png")).toThrow(/Only http and https/);
    expect(() => parseImageUrl("file:///C:/a.png")).toThrow(ToolError);
    expect(() => parseImageUrl("https://user:secret@example.com/a.png")).toThrow(/username or password/);
    expect(() => parseImageUrl("https://user@example.com/a.png")).toThrow(/username or password/);
    expect(() => parseImageUrl("http://")).toThrow(/not a valid URL/);
    expect(parseImageUrl(" https://example.com/a.png ").href).toBe("https://example.com/a.png");
  });
});

describe("withDownloadedImage", () => {
  it("downloads to a temporary file, follows redirects and removes the directory afterwards", async () => {
    requests.length = 0;
    let seenFile = "";
    const result = await withDownloadedImage(`${base}/moved`, async image => {
      seenFile = image.file;
      expect(image.file.endsWith("image.png")).toBe(true);
      expect(image.url).toBe(`${base}/cat.png`);
      expect(image.contentType).toBe("image/png");
      expect(image.bytes).toBe(PNG.length);
      expect(await readFile(image.file)).toEqual(PNG);
      return "used";
    });
    expect(result).toBe("used");
    expect(seenFile).not.toBe("");
    expect(existsSync(dirname(seenFile))).toBe(false);
    expect(requests.map(r => r.url)).toEqual(["/moved", "/cat.png"]);
    expect(requests.every(r => r.userAgent === USER_AGENT)).toBe(true);
  });

  it("names the file after the content type, not the URL", async () => {
    await withDownloadedImage(`${base}/photo`, async image => {
      expect(image.file.endsWith("image.jpg")).toBe(true);
    });
  });

  it("removes the directory when the callback throws", async () => {
    let seenFile = "";
    await expect(
      withDownloadedImage(`${base}/cat.png`, async image => {
        seenFile = image.file;
        throw new Error("model crashed");
      }),
    ).rejects.toThrow("model crashed");
    expect(seenFile).not.toBe("");
    expect(existsSync(dirname(seenFile))).toBe(false);
  });

  it("refuses pages, svg and failed requests without calling back", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    await expect(withDownloadedImage(`${base}/page`, never)).rejects.toThrow(/is not an image \(content type "text\/html"\)/);
    await expect(withDownloadedImage(`${base}/drawing.svg`, never)).rejects.toThrow(/image\/svg\+xml images are not supported/);
    await expect(withDownloadedImage(`${base}/missing.png`, never)).rejects.toThrow(/HTTP 404/);
    await expect(withDownloadedImage(`${base}/page`, never)).rejects.toBeInstanceOf(ToolError);
    await expect(withDownloadedImage("ftp://example.com/a.png", never)).rejects.toThrow(/Only http and https/);
  });

  it("enforces the size cap on the body as well as on Content-Length", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    // No Content-Length: only counting the bytes that arrive can catch this one.
    await expect(withDownloadedImage(`${base}/big.png`, never, { maxBytes: 4000 })).rejects.toThrow(/larger than 4000 bytes/);
    await expect(withDownloadedImage(`${base}/declared-big.png`, never, { maxBytes: 4000 })).rejects.toThrow(/larger than 4000 bytes/);
    // Under the cap, the same image is accepted.
    await expect(withDownloadedImage(`${base}/big.png`, async image => image.bytes, { maxBytes: 6000 })).resolves.toBe(6000);
  });

  it("times out on a download that stalls, and stops when the caller aborts", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    await expect(withDownloadedImage(`${base}/slow.png`, never, { timeoutMs: 200 })).rejects.toThrow(/Timed out fetching/);

    const abort = new AbortController();
    const pending = withDownloadedImage(`${base}/slow.png`, never, { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const error = await pending.catch(e => e);
    expect(error).not.toBeInstanceOf(ToolError);
    expect(error.name).toBe("AbortError");
  });
});

describe("view_image tool", () => {
  let root: string;
  let work: string;
  let seen: { prompt?: string; file?: string; fileExisted?: boolean };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "view-root-"));
    work = await mkdtemp(join(tmpdir(), "view-work-"));
    await writeFile(join(root, "shot.png"), PNG);
    seen = {};
  });

  afterEach(async () => {
    const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
    await rm(root, options).catch(() => {});
    await rm(work, options).catch(() => {});
  });

  /** A client with one loaded vision model that records what it was asked. */
  const visionClient = (respond: () => Promise<any> = async () => ({ content: "A red button.", nonReasoningContent: "A red button." })) => ({
    llm: {
      listLoaded: async () => [
        {
          modelKey: "acme/sees-1",
          getModelInfo: async () => ({ vision: true }),
          respond: async (messages: any[]) => {
            seen.prompt = messages[0].content;
            seen.file = messages[0].images[0].path;
            seen.fileExisted = existsSync(messages[0].images[0].path);
            return respond();
          },
        },
      ],
      model: async () => {
        throw new Error("not used");
      },
    },
    system: { listDownloadedModels: async () => [] },
    files: { prepareImage: async (path: string) => ({ path }) },
  });

  const provider = (client: unknown = visionClient(), overrides: Record<string, unknown> = {}) =>
    toolsProvider(
      fakeController({
        config: { projectFolder: root, visionModel: "", renderScale: 1, maxPages: 10, maxOutputChars: 20000, ...overrides },
        workingDirectory: work,
        client,
      }),
    );

  it("describes a local image with the default prompt and says where the answer comes from", async () => {
    const output = await callTool(await provider(), "view_image", { image: "shot.png" });
    expect(seen.prompt).toBe(DEFAULT_VIEW_PROMPT);
    expect(seen.file).toBe(join(root, "shot.png"));
    expect(output.split("\n").slice(0, 4)).toEqual([
      "shot.png",
      "[Answer from the vision model acme/sees-1, which looked at the image.]",
      "",
      "A red button.",
    ]);
  });

  it("asks the question when one is given", async () => {
    await callTool(await provider(), "view_image", { image: "shot.png", question: "What colour is the button?" });
    expect(seen.prompt).toContain("Question: What colour is the button?");
    expect(seen.prompt).not.toBe(DEFAULT_VIEW_PROMPT);
  });

  it("truncates a long answer", async () => {
    const long = "x".repeat(5000);
    const tools = await provider(visionClient(async () => ({ content: long, nonReasoningContent: long })), { maxOutputChars: 200 });
    const output = await callTool(tools, "view_image", { image: "shot.png" });
    expect(output).toMatch(/^shot\.png\n\[Answer from the vision model/);
    expect(output).toContain("characters truncated");
    expect(output.length).toBeLessThan(600);
  });

  it("refuses paths outside the project folder, missing files and unsupported types", async () => {
    const tools = await provider();
    expect(await callTool(tools, "view_image", { image: "../outside.png" })).toMatch(/^Error: .*outside the allowed root/);
    expect(await callTool(tools, "view_image", { image: "nope.png" })).toMatch(/^Error: .*is not a file/);
    await writeFile(join(root, "notes.txt"), "hello");
    await writeFile(join(root, "drawing.svg"), "<svg/>");
    expect(await callTool(tools, "view_image", { image: "notes.txt" })).toMatch(/^Error: .*is not a supported image/);
    expect(await callTool(tools, "view_image", { image: "drawing.svg" })).toMatch(/^Error: .*is not a supported image/);
    expect(seen.prompt).toBeUndefined(); // the model was never asked
  });

  it("looks at an image from a URL and leaves no temporary directory behind", async () => {
    const output = await callTool(await provider(), "view_image", { image: `${base}/cat.png`, question: "Is it a cat?" });
    expect(output.split("\n").slice(0, 2)).toEqual([
      `${base}/cat.png`,
      "[Answer from the vision model acme/sees-1, which looked at the image.]",
    ]);
    expect(output).toContain("A red button.");
    expect(seen.prompt).toContain("Question: Is it a cat?");
    expect(seen.fileExisted).toBe(true); // there while the model looked
    expect(seen.file!.startsWith(root)).toBe(false);
    expect(existsSync(dirname(seen.file!))).toBe(false); // gone afterwards
  });

  it("refuses URLs that are not images, svg, other schemes and credentials", async () => {
    const tools = await provider();
    expect(await callTool(tools, "view_image", { image: `${base}/page` })).toMatch(/^Error: .*is not an image/);
    expect(await callTool(tools, "view_image", { image: `${base}/drawing.svg` })).toMatch(/^Error: image\/svg\+xml images are not supported/);
    expect(await callTool(tools, "view_image", { image: "ftp://127.0.0.1/cat.png" })).toMatch(/^Error: Only http and https/);
    expect(await callTool(tools, "view_image", { image: "file:///C:/cat.png" })).toMatch(/^Error: Only http and https/);
    const port = new URL(base).port;
    expect(await callTool(tools, "view_image", { image: `http://user:secret@127.0.0.1:${port}/cat.png` })).toMatch(
      /^Error: URLs with a username or password are refused/,
    );
    expect(seen.prompt).toBeUndefined();
  });

  it("says how to get a vision model when none is loaded, before downloading anything", async () => {
    const noVision = {
      llm: { listLoaded: async () => [{ getModelInfo: async () => ({ vision: false }) }], model: async () => ({}) },
      system: { listDownloadedModels: async () => [{ vision: true, modelKey: "acme/sees-1" }] },
      files: { prepareImage: async (path: string) => ({ path }) },
    };
    const tools = await provider(noVision);
    const expected = /^Error: No vision model is loaded\. Load one of these in LM Studio \(or set Vision Model in the plugin's Documents settings\): acme\/sees-1\.$/;
    expect(await callTool(tools, "view_image", { image: "shot.png" })).toMatch(expected);
    requests.length = 0;
    expect(await callTool(tools, "view_image", { image: `${base}/cat.png` })).toMatch(expected);
    expect(requests).toEqual([]);
  });

  it("removes the temporary directory when the model call throws", async () => {
    const tools = await provider(
      visionClient(async () => {
        throw new Error("model crashed");
      }),
    );
    await expect(callTool(tools, "view_image", { image: `${base}/cat.png` })).rejects.toThrow("model crashed");
    expect(seen.fileExisted).toBe(true);
    expect(existsSync(dirname(seen.file!))).toBe(false);
  });
});
