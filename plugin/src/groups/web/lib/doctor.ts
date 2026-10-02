import { existsSync } from "fs";
import { join } from "path";
import { findExecutable, runProcess } from "../../../shared/process";

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

  return lines.join("\n");
}
