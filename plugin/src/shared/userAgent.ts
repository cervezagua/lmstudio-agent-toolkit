/**
 * The User-Agent every request from these tools carries: a browser-like string so ordinary sites
 * answer, with an honest suffix saying what is really asking. It lives here, away from the page
 * fetcher, so a group that only downloads a file does not load the HTML parsing libraries.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 lmstudio-web-tools";
