import { existsSync } from "fs";
import { join } from "path";
import { findExecutable, runProcess } from "../../../shared/process";
import { USER_AGENT } from "../../../shared/userAgent";
import { TOOLKIT_VERSION } from "../../../version";

/**
 * What the Web group can use on this machine, one line per piece, each with what a missing piece
 * costs and how to fix it. Read-only: no browser is launched and nothing is installed.
 */
export interface DoctorInput {
  backend: string;
  searxngUrl: string;
  /** Whether a Brave key is set; the key itself never reaches this code. */
  braveKeySet: boolean;
  browserEnabled: boolean;
  channel: string;
  ytDlp: string | null;
  /** Overridable for tests. */
  browserPath?: (channel: string) => string | null;
  /** Overridable for tests: what asks GitHub for the latest release. */
  fetchRelease?: typeof fetch;
}

export const LATEST_RELEASE_URL = "https://api.github.com/repos/cervezagua/lmstudio-agent-toolkit/releases/latest";

/** Compares dotted versions number by number ("0.10.0" is newer than "0.9.2"); a missing segment is 0. */
export function compareVersions(a: string, b: string): number {
  const segments = (version: string) => version.split(".").map(part => parseInt(part, 10) || 0);
  const left = segments(a);
  const right = segments(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * Whether a newer release exists. This is the only place the plugin contacts GitHub, and only when
 * the model runs web_doctor. Whatever goes wrong becomes one quiet line: it never fails the report.
 */
export async function checkLatestRelease(fetchRelease: typeof fetch = fetch, installed = TOOLKIT_VERSION): Promise<string> {
  try {
    const response = await fetchRelease(LATEST_RELEASE_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
    const release: any = await response.json();
    const latest = typeof release?.tag_name === "string" ? release.tag_name.trim().replace(/^v/i, "") : "";
    if (!/^\d+(\.\d+)*/.test(latest)) throw new Error("the latest release has no version number");
    const order = compareVersions(installed, latest);
    if (order === 0) return `✓ agent-toolkit ${installed} is the latest release.`;
    if (order > 0) return `✓ agent-toolkit ${installed} (newer than the latest release ${latest})`;
    const url = typeof release.html_url === "string" ? release.html_url : "";
    return `~ agent-toolkit ${installed} is installed; ${latest} is available${url ? `: ${url}` : "."}`;
  } catch (error: any) {
    const reason =
      error?.name === "TimeoutError"
        ? "GitHub did not answer in 3 s"
        : error instanceof SyntaxError
          ? "GitHub's answer was not JSON"
          : String(error?.cause?.message ?? error?.message ?? error).split("\n")[0];
    return `~ Could not check for a newer version (${reason}).`;
  }
}

/** Where Edge and Chrome install themselves on each system. */
export function findBrowser(channel: string): string | null {
  const env = process.env;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]].filter(Boolean) as string[];
    const app = channel === "msedge" ? ["Microsoft", "Edge", "Application", "msedge.exe"] : ["Google", "Chrome", "Application", "chrome.exe"];
    for (const root of roots) candidates.push(join(root, ...app));
  } else if (process.platform === "darwin") {
    candidates.push(
      channel === "msedge"
        ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    const names = channel === "msedge" ? ["microsoft-edge", "microsoft-edge-stable"] : ["google-chrome", "google-chrome-stable"];
    for (const name of names) {
      const found = findExecutable(name);
      if (found) return found;
    }
  }
  return candidates.find(path => existsSync(path)) ?? null;
}

async function checkSearxng(baseUrl: string): Promise<string> {
  if (!baseUrl.trim()) return "✗ SearXNG: no URL is set.";
  const url = `${baseUrl.replace(/\/+$/, "")}/search?q=ping&format=json`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.status === 403) {
      return `✗ SearXNG at ${baseUrl} answers, but has the JSON format switched off. Enable "json" under search.formats in its settings.yml.`;
    }
    if (!response.ok) return `✗ SearXNG at ${baseUrl} answered HTTP ${response.status}.`;
    return `✓ SearXNG at ${baseUrl} answers.`;
  } catch {
    return `✗ SearXNG at ${baseUrl} is not reachable. Search falls back to DuckDuckGo, which often answers automated requests with a bot check. Start SearXNG, or see searxng/README.md to set one up.`;
  }
}

export async function runWebDoctor(input: DoctorInput): Promise<string> {
  const lines: string[] = [];

  if (input.backend === "brave") {
    lines.push(input.braveKeySet ? "✓ Search: Brave, with an API key set." : "✗ Search: Brave is selected, but no API key is set (global settings).");
  } else if (input.backend === "duckduckgo") {
    lines.push("~ Search: DuckDuckGo only. It needs no setup, but often answers automated requests with a bot check.");
  } else {
    lines.push(`${input.backend === "searxng" ? "Search: SearXNG only." : "Search: SearXNG first, DuckDuckGo if it is down."}`);
    lines.push(await checkSearxng(input.searxngUrl));
  }

  if (!input.browserEnabled) {
    lines.push("~ Browser tools are switched off (Enable Browser Tools).");
  } else if (input.channel === "chromium") {
    lines.push("~ Browser: chromium, Playwright's own build. If it is missing, run: npx playwright install chromium");
  } else {
    const path = (input.browserPath ?? findBrowser)(input.channel);
    const name = input.channel === "msedge" ? "Microsoft Edge" : "Google Chrome";
    lines.push(path ? `✓ Browser: ${name} (${path}).` : `✗ Browser: ${name} was not found. Install it, or pick another browser in the settings.`);
  }

  if (input.ytDlp) {
    const version = await runProcess(input.ytDlp, ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 }).catch(() => null);
    lines.push(`✓ yt-dlp ${version?.stdout.trim() || ""}`.trimEnd() + " (video_transcript is available).");
  } else {
    lines.push("✗ yt-dlp is not installed, so video_transcript is not offered. Install it with `winget install yt-dlp`, `brew install yt-dlp` or `pip install yt-dlp`, then restart the plugin.");
  }

  lines.push(await checkLatestRelease(input.fetchRelease));

  return lines.join("\n");
}
