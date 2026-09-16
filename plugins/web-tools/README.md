# web-tools

*Part of the [LM Studio Agent Toolkit](https://github.com/cervezagua/lmstudio-agent-toolkit) — five plugins for files and shell, memory, git, the web and documents. Install the others with `lms get cervezagua/<plugin>`.*

Web search, page reading, and a real browser for LM Studio models. Search runs through your own SearXNG instance (falling back to DuckDuckGo), pages come back as clean markdown, and the browser tools drive your installed Edge or Chrome.

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `web_search` | `query`, `count?` | Titles, URLs and snippets from the configured search backend |
| `fetch_url` | `url`, `max_chars?`, `offset?`, `refresh?` | Downloads a page and returns its main content as markdown (Readability + Turndown), with absolute links. Also reads PDFs page by page; plain text and JSON come back as-is. `offset` continues a long document where the last call stopped. Results are cached for ten minutes unless `refresh` is set, and a redirect to another host is reported in the result. Downloads are capped at 5 MB with a 30 s timeout, and retried on temporary failures. |
| `browser_open` | `url` | Opens the URL in a real browser (runs JavaScript) and returns a snapshot |
| `browser_snapshot` | – | A fresh snapshot of the current page |
| `browser_click` | `ref` | Clicks element `[ref]` from the latest snapshot, then returns the new snapshot |
| `browser_type` | `ref`, `text`, `submit?` | Fills an input or textarea (or picks a `<select>` option by label); `submit` presses Enter |
| `browser_back` | – | Goes back in history |
| `browser_screenshot` | `full_page?` | Saves a PNG to `<chat working directory>/screenshots/` and returns its path |
| `browser_close` | – | Closes the browser |

A snapshot looks like this:

```
Title: Search Form
URL: http://example.test/form

Interactive elements (pass the number as ref to browser_click / browser_type):
[1] textbox "Query" value=""
[2] button "Go"
[3] link "Next page" -> /next

Page text:
Find things
...
```

Only visible, enabled elements get a number. Links that open a new tab are followed automatically.

## Search backends

| Backend | Setup | Notes |
|---|---|---|
| `auto` *(default)* | none | Uses SearXNG at **SearXNG URL** if it responds; otherwise DuckDuckGo. When it falls back, the result says so. |
| `searxng` | a SearXNG instance with the `json` format enabled | Recommended. Private, no API key, combines results from many engines. |
| `duckduckgo` | none | Often answers automated requests with a bot check; the tool reports that instead of retrying or working around it. |
| `brave` | a Brave Search API key in the global settings | |

### Running SearXNG

The repository's [`searxng/`](../../searxng) folder sets up SearXNG in WSL (Ubuntu) as a systemd service on `http://localhost:8888`, which is the default **SearXNG URL**. For any other SearXNG instance, make sure its `settings.yml` contains:

```yaml
search:
  formats:
    - html
    - json
server:
  limiter: false   # the bot limiter would block the plugin's requests
```

## Settings

| Setting | Scope | Default | Notes |
|---|---|---|---|
| Search Backend | chat | auto | |
| SearXNG URL | chat | `http://localhost:8888` | |
| Default Search Results | chat | 8 | The model can ask for up to 20. |
| Max Page Characters | chat | 15000 | Applies to `fetch_url` and snapshots. Lower it for small context windows. |
| Browser Fallback for fetch_url | chat | on | When a fetched page has almost no text (a JavaScript-only site), render it in the browser instead. |
| Enable Browser Tools | chat | on | Off leaves only `web_search` and `fetch_url`. |
| Browser | chat | msedge | `msedge` and `chrome` use the installed browser. `chromium` needs `npx playwright install chromium` in the plugin folder. |
| Headless Browser | chat | on | Turn it off to watch the model use the browser. |
| Brave Search API Key | global | – | Stored as a protected field. |

## Notes

- The browser has its own fresh profile: no cookies, logins or extensions from your normal browser. All chats share one browser. It stays open until the model calls `browser_close` or the plugin restarts.
- `fetch_url` can reach any http(s) address your computer can, including local network services. Keep LM Studio's tool call confirmation on if that matters to you.
- Pages built with JavaScript often come back nearly empty from `fetch_url`; the model is told to use `browser_open` for those.

## Development

```bash
npm install
```

```bash
lms dev
```

Tests live in the repository root (`npm test`). They start a local HTTP server and drive Edge, and never touch the internet unless you set `LIVE_WEB=1`. The `src/shared/` files are copied from the repository's `shared/` folder; edit them there.
