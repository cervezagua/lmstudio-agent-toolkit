import { describe, expect, it, vi } from "vitest";
import { CappedOutput, runProcess } from "../../shared/process";
import { extractPdfText } from "./lib/pdf";

// The worker's output, without a real PDF: what it prints is what these tests are about.
vi.mock("../../shared/process", async importOriginal => ({
  ...(await importOriginal<typeof import("../../shared/process")>()),
  runProcess: vi.fn(),
}));

const printed = (stdout: string, stderr = "") =>
  vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, stdout, stderr, timedOut: false, aborted: false });

describe("the PDF worker's output", () => {
  it("says to read fewer pages when the text was too large to arrive whole", async () => {
    // As runProcess hands over an output past its cap: the two ends, the middle left out.
    const output = new CappedOutput(1000);
    output.push(JSON.stringify({ ok: true, totalPages: 900, pages: [{ page: 1, text: "word ".repeat(2000) }] }));
    printed(output.text());
    await expect(extractPdfText("big.pdf")).rejects.toThrow(/^The PDF's text is too large to read at once\. Use pages/);
  });

  it("quotes no more than the start of output it cannot read", async () => {
    printed(`{"ok": true, "pages": ["${"x".repeat(100_000)}`);
    const error = await extractPdfText("odd.pdf").catch(caught => caught as Error);
    expect(error.message).toMatch(/^Could not read the PDF: \{"ok": true/);
    expect(error.message.length).toBeLessThan(300);
  });
});
