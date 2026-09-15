import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "searchBackend",
    "select",
    {
      displayName: "Search Backend",
      subtitle:
        "auto = SearXNG if reachable, else DuckDuckGo. searxng = your instance only (JSON format enabled). " +
        "duckduckgo needs no setup but often hits bot checks. brave needs an API key (global settings).",
      options: ["auto", "searxng", "duckduckgo", "brave"],
    },
    "auto",
  )
  .field(
    "searxngUrl",
    "string",
    {
      displayName: "SearXNG URL",
      subtitle: "Base URL of your SearXNG instance, used by the auto and searxng backends.",
      placeholder: "http://localhost:8888",
    },
    "http://localhost:8888",
  )
  .field(
    "maxSearchResults",
    "numeric",
    { int: true, min: 1, max: 20, displayName: "Default Search Results" },
    8,
  )
  .field(
    "maxPageChars",
    "numeric",
    {
      int: true,
      min: 1000,
      max: 200000,
      displayName: "Max Page Characters",
      subtitle: "Fetched pages and browser snapshots are truncated to this length.",
    },
    15000,
  )
  .field(
    "browserFallback",
    "boolean",
    {
      displayName: "Browser Fallback for fetch_url",
      subtitle: "When a fetched page has almost no text (JavaScript-only sites), render it in the browser instead.",
    },
    true,
  )
  .field(
    "enableBrowser",
    "boolean",
    {
      displayName: "Enable Browser Tools",
      subtitle: "Expose browser_* tools that drive a real Edge/Chrome window via Playwright.",
    },
    true,
  )
  .field(
    "browserChannel",
    "select",
    {
      displayName: "Browser",
      subtitle: "msedge and chrome use the installed browser. chromium needs `npx playwright install chromium`.",
      options: ["msedge", "chrome", "chromium"],
    },
    "msedge",
  )
  .field(
    "headless",
    "boolean",
    {
      displayName: "Headless Browser",
      subtitle: "Turn off to watch the browser while the model uses it.",
    },
    true,
  )
  .build();

export const globalConfigSchematics = createConfigSchematics()
  .field(
    "braveApiKey",
    "string",
    {
      displayName: "Brave Search API Key",
      subtitle: "Only needed when a chat uses the brave search backend.",
      isProtected: true,
    },
    "",
  )
  .build();
