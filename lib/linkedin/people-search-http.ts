// People search without a browser. Opening li_at in headless Chrome makes
// LinkedIn revoke the session and sign the person out of their own browser.

import type { PlaywrightCookie } from "./cookie-paste";
import {
  peopleFromSearchSnapshot,
  type ScrapedProfile,
  type WindowedScrapeResult,
} from "./scraper";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cookieHeader(cookies: PlaywrightCookie[]): string {
  const now = Date.now() / 1000;
  const chosen = new Map<string, PlaywrightCookie>();
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue;
    if (cookie.expires > 0 && cookie.expires < now) continue;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (domain !== "linkedin.com" && !domain.endsWith(".linkedin.com")) continue;
    const prev = chosen.get(cookie.name);
    const specific = cookie.domain.includes("www.linkedin.com");
    if (!prev || (specific && !prev.domain.includes("www.linkedin.com"))) chosen.set(cookie.name, cookie);
  }
  return [...chosen.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function pageUrl(raw: string, pageNum: number): string {
  const parsed = new URL(raw);
  if (pageNum <= 1) parsed.searchParams.delete("page");
  else parsed.searchParams.set("page", String(pageNum));
  return parsed.toString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Pull profile links and visible lines out of a LinkedIn search document. */
export function profilesFromSearchHtml(html: string): ScrapedProfile[] {
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const source = mainMatch ? mainMatch[1] : html;
  const anchors: { href: string; name: string }[] = [];
  const anchorRe = /<a\b[^>]*href="([^"]*\/in\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(source))) {
    const href = decodeEntities(match[1]);
    const inner = match[2];
    const aria = inner.match(/aria-hidden="true"[^>]*>([^<]+)/i);
    const name = decodeEntities((aria ? aria[1] : inner.replace(/<[^>]+>/g, " ")).trim());
    if (name) anchors.push({ href, name });
  }
  const lines = decodeEntities(
    source
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|li|p|span|h[1-6]|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && line.length < 180);
  return peopleFromSearchSnapshot(anchors, lines);
}

function looksLoggedOut(html: string, location: string): boolean {
  if (/login|checkpoint|authwall|uas\/login/i.test(location)) return true;
  return /<title>[^<]*(Sign in|Log in)/i.test(html) || /Welcome to your professional community/i.test(html.slice(0, 12000));
}

const LOGIN_ERROR =
  "LinkedIn sent this account back to the login page. Authenticate it in Settings → LinkedIn, then import again.";

function sameUrl(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return (
    left.origin === right.origin &&
    left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "") &&
    left.searchParams.toString() === right.searchParams.toString()
  );
}

/**
 * One search page, over HTTP. Does not launch a browser.
 * A full page of 10 means more pages may exist; this call does not fetch them.
 */
export async function scrapePeopleSearchHttp(
  cookies: PlaywrightCookie[],
  searchUrl: string,
  startPage = 1
): Promise<WindowedScrapeResult> {
  let url = pageUrl(searchUrl, startPage);
  const header = cookieHeader(cookies);
  let response: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": CHROME_UA,
        "accept-language": "en-US,en;q=0.9",
        cookie: header,
      },
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location") ?? "";
    if (/login|checkpoint|authwall/i.test(location)) throw new Error(LOGIN_ERROR);
    const next = new URL(location || url, url);
    if (!next.hostname.endsWith("linkedin.com") || !next.pathname.includes("/search/results/people")) {
      throw new Error("LinkedIn redirected this search away from the results page.");
    }
    const nextUrl = next.toString();
    if (sameUrl(nextUrl, url)) throw new Error(LOGIN_ERROR);
    url = nextUrl;
  }
  if (!response) throw new Error(LOGIN_ERROR);
  const html = await response.text();
  if (looksLoggedOut(html, response.url || url)) throw new Error(LOGIN_ERROR);
  const profiles = profilesFromSearchHtml(html);
  if (profiles.length === 0) {
    throw new Error("No people were returned for this LinkedIn search. Check the filters, or re-authenticate the LinkedIn account.");
  }
  return {
    profiles,
    lastPage: startPage,
    knownTotal: profiles.length,
    exhausted: profiles.length < 10,
  };
}
