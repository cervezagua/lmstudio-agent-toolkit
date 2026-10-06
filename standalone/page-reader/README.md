# page-reader

**Give your model a link and it reads the page.** An article, a documentation page, a PDF report: it comes back as clean text without the menus and clutter, so the model can summarise it, quote it or answer questions from what it actually says.

[Project home](https://github.com/cervezagua/lmstudio-agent-toolkit) · [Report a problem](https://github.com/cervezagua/lmstudio-agent-toolkit/issues)

---

## Try it

> *"Summarise https://example.com/blog/some-post in five bullet points."*

> *"Read this PDF and tell me what it says about delivery times: https://example.com/report.pdf"*

> *"What does the pricing table on https://example.com/pricing say? Only the table."*

## The tool

| Tool | What it does |
|---|---|
| `fetch_url` | Downloads a web page and returns its main content as markdown. |

- **The article, not the page around it.** Navigation, footers, scripts and forms are dropped; headings, links, lists and code are kept.
- **PDFs, plain text and JSON too.** PDFs are read page by page, up to 5 MB; of a bigger web page, the first 5 MB is read.
- **Long documents come in parts.** The model asks for the next part when it needs it.
- **Part of a page.** With `selector`, a CSS selector such as `main` or `table#prices`, only the matching elements come back: much shorter than the whole page.
- **Quick to re-read.** Pages are kept in memory for ten minutes, so going back to one doesn't download it again; `refresh` fetches a fresh copy.
- **Patient with busy sites.** A server that answers "try again later" gets two more tries.

**Pages that need JavaScript come back nearly empty.** This plugin downloads the page as the site sends it and does not run scripts, so a site that builds its content in the browser has little or nothing to read. The tool says so when that happens. For those sites you need a real browser, such as the browser tools in agent-toolkit.

## Settings

| Setting | Default | |
|---|---|---|
| Max Characters | 15000 | How much of a page comes back at once. |

## Privacy and safety

- **The page comes straight from the site, and nothing else is contacted.** No accounts, no API keys.
- **Only `http` and `https` links are fetched.** Anything else, such as a `file:` link to something on your computer, is refused, and so are links with a username or password in them.
- **Redirects are followed, and shown.** If a link ends up on a different site, the result says where it came from.
- **Nothing is written to disk.** Cached pages live in memory and are gone when the plugin stops.
- **It reads whatever address it's given**, including ones on your own network, so let the model open only links you'd open yourself.

---

**Using agent-toolkit?** Its Web group already includes `fetch_url`, so you don't need this plugin as well. Enabling both in one chat gives the model the same tool twice.

MIT licensed · Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit)
