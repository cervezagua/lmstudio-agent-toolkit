# video-transcripts

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit). The same tool is in agent-toolkit's Web group.*

Lets an LM Studio model read what's said in a video, so it can summarise or answer questions about it instead of guessing from the title. Works with YouTube and most other video sites, through [yt-dlp](https://github.com/yt-dlp/yt-dlp).

| Tool | Parameters | What it does |
|---|---|---|
| `video_transcript` | `url`, `language?`, `offset?`, `max_chars?` | Returns the video's title, channel, length and transcript. Prefers subtitles a person wrote; falls back to automatic captions and says so. Long transcripts come in parts. |

## Setup

Install yt-dlp, then restart LM Studio (or turn the plugin off and on):

```bash
winget install yt-dlp
```

On macOS, `brew install yt-dlp`; on Linux, your package manager or `pip install yt-dlp`. Without it the tool isn't offered at all, so it never shows up as a tool that can only fail.

Only subtitles are downloaded, into a temporary folder that's deleted afterwards; never the video. yt-dlp runs directly, not through a shell.

Try: *"Summarise https://www.youtube.com/watch?v=… in five bullet points."*

| Setting | Default | |
|---|---|---|
| **Max Characters** | 15000 | Longer transcripts are returned in parts. |

> [!NOTE]
> Using **agent-toolkit** with its Web group on? It already has `video_transcript`, so don't enable this plugin in the same chat, or the model sees the tool twice.
