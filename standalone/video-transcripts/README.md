# video-transcripts

**Let your model watch the video for you.** Give it a YouTube link and it reads what's said: to summarise a talk, find the part about one topic, or answer questions instead of guessing from the title.

[Project home](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Report a problem](https://github.com/cervezagua/lmstudio-agent-toolkit/issues)

---

## Try it

> *"Summarise this talk in five bullet points: https://www.youtube.com/watch?v=…"*

> *"What does the speaker say about caching?"*

> *"Give me the recipe from this video as a shopping list."*

## Setup

This plugin uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), a free tool for reading video sites. Install it once:

| Windows | macOS | Linux |
|---|---|---|
| `winget install yt-dlp` | `brew install yt-dlp` | your package manager, or `pip install yt-dlp` |

Then turn the plugin off and on in LM Studio, or restart LM Studio. The tool only appears once yt-dlp is found, so it never shows up as a tool that can only fail.

## The tool

| Tool | What it does |
|---|---|
| `video_transcript` | Returns the video's title, channel, length and transcript. |

- **Works with YouTube and most other video sites** that yt-dlp supports.
- **Prefers subtitles written by a person**, and falls back to automatic captions, saying so when it does.
- **Other languages:** ask with `language` (default English), if the video has subtitles in it.
- **Plain text, without timestamps**, which keeps it short; it can say what was said, not exactly when.
- **Long transcripts come in parts.** The model asks for the next part when it needs it.

## Settings

| Setting | Default | |
|---|---|---|
| Max Characters | 15000 | How much of a transcript comes back at once. |

## Privacy and safety

- **Only the subtitles are downloaded, never the video**, into a temporary folder that's deleted straight away.
- **Nothing goes anywhere except the video site itself.** No accounts, no API keys.
- **yt-dlp runs directly, never through a shell**, and anything that isn't an `http` or `https` link is refused.

---

**Using agent-toolkit?** Its Web group already includes `video_transcript`, so you don't need this plugin as well. Enabling both in one chat gives the model the same tool twice.

MIT licensed · Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit)
