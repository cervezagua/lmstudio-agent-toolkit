# feed-reader

**Keep up with the sites you follow, through your model.** Give it a blog, a news site or a project's releases and it reads the latest posts: what's new, what changed, what's worth opening.

[Project home](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Report a problem](https://github.com/cervezagua/lmstudio-agent-toolkit/issues)

---

## Try it

> *"What's new on https://example.com/blog? Summarise the three latest posts."*

> *"Check the releases feed for this project and tell me if anything mentions Windows."*

> *"Anything about local models on these three news sites this week?"*

## The tool

| Tool | What it does |
|---|---|
| `read_feed` | Lists a feed's latest items, newest first: title, date, link and a short summary. |

- **RSS and Atom**, which covers nearly every blog, news site, podcast and release page.
- **No need to find the feed.** Give it a site's home page and it follows the feed that page points to.
- **Clean summaries.** HTML is stripped, and each summary is cut to a few lines.
- **Ten items by default**, up to fifty with `limit`.

To read a whole article, let the model open the item's link. agent-toolkit's `fetch_url` does that, as does any page-reading plugin.

## Setup

None: no settings, no accounts, no API keys. The feed comes straight from the site, and nothing else is contacted.

---

**Using agent-toolkit?** Its Web group already includes `read_feed`, so you don't need this plugin as well. Enabling both in one chat gives the model the same tool twice.

MIT licensed · Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit)
