import { text, tool, type Tool } from "@lmstudio/sdk";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { safe, ToolError } from "../../../shared/errors";
import { findExecutable, runProcess } from "../../../shared/process";

/**
 * Video transcripts through yt-dlp, which handles YouTube and many other video sites. Self-contained
 * so it can also ship as the standalone video-transcripts plugin: it imports only from shared/.
 */

/**
 * WebVTT to plain text. Automatic captions "roll": each cue repeats the previous line and adds a
 * few words, so the same text arrives two or three times; consecutive repeats are collapsed.
 */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "") // inline word timings
      .replace(/<\/?[a-z][^>]*>/gi, "") // <c>, <i>, <v Speaker> and friends
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (!line) continue;
    if (/^WEBVTT\b/.test(line) || /^(Kind|Language|NOTE|STYLE|REGION)\b/.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // cue number
    if (/-->/.test(line)) continue; // timing line
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  // A rolling caption can also restate the tail of the previous line at the start of the next.
  const merged: string[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && line.startsWith(previous)) merged[merged.length - 1] = line;
    else if (previous && previous.endsWith(line)) continue;
    else merged.push(line);
  }
  return merged.join("\n");
}

export function formatDuration(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** Refuses anything that is not a plain http(s) URL, and anything yt-dlp could read as an option. */
export function checkVideoUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("-")) throw new ToolError("That is not a URL.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolError(`"${url}" is not a valid URL. Pass the video's full address, e.g. https://www.youtube.com/watch?v=…`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ToolError("Only http and https video URLs are supported.");
  if (parsed.username || parsed.password) throw new ToolError("URLs with a username or password are refused.");
  return parsed.href;
}

/** Subtitle languages to ask for: the requested one and its regional variants. */
export function subtitleLanguages(language: string): string {
  const base = language.trim().toLowerCase().replace(/[^a-z-]/g, "") || "en";
  return `${base},${base}-.*,${base}.*`;
}

export interface Transcript {
  title: string;
  channel: string;
  duration: string;
  language: string;
  automatic: boolean;
  text: string;
}

/** Runs yt-dlp for subtitles only, into a temporary folder that is removed afterwards. */
export async function fetchTranscript(
  ytDlp: string,
  url: string,
  options: { language?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Transcript> {
  const folder = await mkdtemp(join(tmpdir(), "video-transcript-"));
  try {
    const args = [
      "--skip-download",
      "--no-simulate", // -J alone implies simulate, which would skip writing the subtitles
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      subtitleLanguages(options.language ?? "en"),
      "--sub-format",
      "vtt",
      "-o",
      join(folder, "video.%(ext)s"),
      "--",
      checkVideoUrl(url),
    ];
    const result = await runProcess(ytDlp, args, {
      cwd: folder,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
    });
    if (result.timedOut) throw new ToolError("yt-dlp took too long and was stopped.");
    if (result.exitCode !== 0) {
      const reason = result.stderr.split("\n").find(line => /ERROR/.test(line)) ?? result.stderr.trim().split("\n").pop() ?? "";
      throw new ToolError(`yt-dlp could not read that video: ${reason.replace(/^ERROR:\s*/, "").slice(0, 300) || `exit code ${result.exitCode}`}`);
    }

    let info: any = {};
    try {
      info = JSON.parse(result.stdout);
    } catch {
      // the subtitles are what matter; carry on without the title and channel
    }
    // Human subtitles are written as video.<lang>.vtt; automatic ones only when none exist.
    const files = (await readdir(folder)).filter(name => name.endsWith(".vtt"));
    if (files.length === 0) {
      throw new ToolError(`No ${options.language ?? "en"} subtitles or automatic captions are available for that video.`);
    }
    const file = files.sort((a, b) => a.length - b.length)[0];
    const language = file.replace(/^video\./, "").replace(/\.vtt$/, "");
    const manual = info?.subtitles && Object.keys(info.subtitles).some((key: string) => key === language);
    return {
      title: String(info?.title ?? ""),
      channel: String(info?.channel ?? info?.uploader ?? ""),
      duration: formatDuration(info?.duration),
      language,
      automatic: !manual,
      text: vttToText(await readFile(join(folder, file), "utf-8")),
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The video_transcript tool, or nothing when yt-dlp is not installed: a tool that can only say
 * "install yt-dlp" would just lengthen the tool list.
 */
export function makeVideoTranscriptTools(options: { maxChars: number }): Tool[] {
  const ytDlp = findExecutable("yt-dlp");
  if (!ytDlp) return [];
  return [
    tool({
      name: "video_transcript",
      description: text`
        Get the transcript of a video (YouTube and most other video sites) with its title, channel
        and length. Use it to answer questions about a video instead of guessing from its title.
        Long transcripts are cut off: pass offset (characters already read) to continue.
      `,
      parameters: {
        url: z.string(),
        language: z.string().optional().describe("subtitle language code, default en"),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(500).max(200000).optional(),
      },
      implementation: safe(async ({ url, language, offset, max_chars }, ctx) => {
        ctx.status("Fetching the transcript");
        const transcript = await fetchTranscript(ytDlp, url, { language, signal: ctx.signal });
        const start = offset ?? 0;
        if (start >= transcript.text.length && transcript.text.length > 0) {
          throw new ToolError(`offset ${start} is past the end of this transcript (${transcript.text.length} characters).`);
        }
        const limit = max_chars ?? options.maxChars;
        const slice = transcript.text.slice(start, start + limit);
        const left = transcript.text.length - start - slice.length;
        const header =
          (transcript.title ? `Title: ${transcript.title}\n` : "") +
          (transcript.channel ? `Channel: ${transcript.channel}\n` : "") +
          (transcript.duration ? `Length: ${transcript.duration}\n` : "") +
          `Transcript: ${transcript.language}${transcript.automatic ? " (automatic captions, may contain errors)" : ""}\n`;
        return `${header}\n${slice}${left > 0 ? `\n\n[${left} characters left; call again with offset ${start + slice.length}]` : ""}`;
      }),
    }),
  ];
}
