# feed-reader

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit). The same tool is in agent-toolkit's Web group.*

Lets an LM Studio model read RSS and Atom feeds: blogs, news sites, release notes, podcasts.

| Tool | Parameters | What it does |
|---|---|---|
| `read_feed` | `url`, `limit?` | Lists a feed's latest items, newest first: title, date, link and a short plain-text summary (10 by default). Accepts a feed's URL, or a site's page that links to its feed. |

No settings, no API keys. The feed is fetched directly from its site; nothing else is contacted.

Try: *"What's new on https://example.com/blog? Summarise the three latest posts."*

> [!NOTE]
> Using **agent-toolkit** with its Web group on? It already has `read_feed`, so don't enable this plugin in the same chat, or the model sees the tool twice.
