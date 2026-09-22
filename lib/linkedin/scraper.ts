/**
 * Sales Navigator list scraper using the internal Sales API.
 * Uses Playwright's browser context request (inherits browser TLS fingerprint).
 *
 * Response format discovery (from capture scripts):
 * - ctx.request returns normalized JSON: { data: { metadata: { totalDisplayCount: "106" } }, included: [...] }
 * - Profiles are in `included` filtered by entityUrn containing "salesProfile"
 * - Browser-intercepted first page returns flat: { elements: [...], paging: { total } }
 * - Query format: parentheses/commas unencoded, colons in URN encoded as %3A
 *
 * IMPORTANT — vanityName is gone from salesApiPeopleSearch (dropped by LinkedIn ~March 2026):
 * The list API no longer returns vanityName. To get the real /in/ URL we call
 * salesApiProfiles per batch of 25 after scraping, using flagshipProfileUrl.
 * See docs/linkedin-api-learnings.md for the full investigation.
 */
import type { BrowserContext, Page } from "playwright";

export interface ScrapedProfile {
  salesNavUrn: string;
  salesNavUrl: string;
  linkedinUrl: string | null;  // regular /in/ URL
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  degree: number | null;
  // Extended fields
  objectUrn: string | null;       // urn:li:member:XXXX — stable LinkedIn member ID
  summary: string | null;         // About / bio text
  openLink: boolean;              // can message without connecting
  companyIndustry: string | null;
  companyLocation: string | null; // company HQ location
  tenureMonths: number | null;    // months in current role
  spotlightBadges: string | null; // JSON array of badge displayValues
}

interface SalesProfile {
  entityUrn: string;
  objectUrn?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  vanityName?: string;
  geoRegion?: string;
  degree?: number;
  summary?: string;
  openLink?: boolean;
  premium?: boolean;
  pendingInvitation?: boolean;
  currentPositions?: Array<{
    title?: string;
    companyName?: string;
    companyUrn?: string;
    current?: boolean;
    description?: string;
    startedOn?: { year?: number; month?: number };
    tenureAtPosition?: { numYears?: number; numMonths?: number };
    tenureAtCompany?: { numYears?: number; numMonths?: number };
    companyUrnResolutionResult?: {
      name?: string;
      industry?: string;
      location?: string;
      entityUrn?: string;
    };
  }>;
  leadAssociatedAccount?: { name?: string } | null;
  spotlightBadges?: Array<{ displayValue?: string; id?: string }>;
}

// Flat response intercepted from browser
interface FlatResponse {
  elements?: SalesProfile[];
  paging?: { total: number; count: number; start: number };
}

// salesApiProfiles single-profile response
interface ProfileDetailResponse {
  entityUrn?: string;
  flagshipProfileUrl?: string;
  fullName?: string;
}

function extractListId(url: string): string | null {
  const match = url.match(/\/sales\/lists\/people\/(\d+)/);
  return match ? match[1] : null;
}

function extractSavedSearchId(url: string): string | null {
  const match = url.match(/[?&]savedSearchId=(\d+)/);
  return match ? match[1] : null;
}

/** Regular LinkedIn people search, e.g. /search/results/people/?keywords=...&network=...&geoUrn=... */
export function isLinkedInPeopleSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host !== "linkedin.com") return false;
    return /^\/search\/results\/people\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function peopleSearchPageUrl(raw: string, pageNum: number): string {
  const parsed = new URL(raw);
  if (pageNum <= 1) parsed.searchParams.delete("page");
  else parsed.searchParams.set("page", String(pageNum));
  return parsed.toString();
}

function textOf(node: unknown): string | null {
  if (typeof node === "string") return node.trim() || null;
  if (!node || typeof node !== "object") return null;
  const text = (node as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function normalizeProfileUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw, "https://www.linkedin.com");
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/);
    if (!match) return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(match[1])}/`;
  } catch {
    return null;
  }
}

function parseDegree(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/([123])(?:st|nd|rd)/i);
  return match ? Number(match[1]) : null;
}

function splitName(full: string | null): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function splitHeadline(headline: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const parts = headline.split(/\s+at\s+/i);
  if (parts.length >= 2) {
    return { title: parts[0].trim() || null, company: parts.slice(1).join(" at ").trim() || null };
  }
  return { title: headline, company: null };
}

function isPeopleEntityResult(obj: Record<string, unknown>): boolean {
  const type = obj.$type;
  if (typeof type === "string" && type.includes("EntityResultViewModel")) return true;
  return typeof obj.navigationUrl === "string" && obj.navigationUrl.includes("/in/") && obj.title != null;
}

interface PeopleSearchHit {
  profile: ScrapedProfile;
}

function resultFromEntity(obj: Record<string, unknown>): PeopleSearchHit | null {
  const navigationUrl = typeof obj.navigationUrl === "string" ? obj.navigationUrl : null;
  if (!navigationUrl) return null;
  const linkedinUrl = normalizeProfileUrl(navigationUrl);
  if (!linkedinUrl) return null;

  const fullName = textOf(obj.title);
  const headline = textOf(obj.primarySubtitle);
  const { title, company } = splitHeadline(headline);
  const { firstName, lastName } = splitName(fullName);
  const trackingUrn = typeof obj.trackingUrn === "string" ? obj.trackingUrn : null;
  const entityUrn = typeof obj.entityUrn === "string" ? obj.entityUrn : trackingUrn ?? linkedinUrl;

  return {
    profile: {
      salesNavUrn: entityUrn,
      salesNavUrl: "",
      linkedinUrl,
      fullName,
      firstName,
      lastName,
      title,
      company,
      location: textOf(obj.secondarySubtitle),
      degree: parseDegree(textOf(obj.badgeText)),
      objectUrn: trackingUrn,
      summary: null,
      openLink: false,
      companyIndustry: null,
      companyLocation: null,
      tenureMonths: null,
      spotlightBadges: null,
    },
  };
}

const CARD_ACTION = /^(connect|message|follow|pending|save|premium|follow)$/i;

/** Turn one visible search-result card into a lead. */
export function profileFromSearchCard(href: string, lines: string[]): ScrapedProfile | null {
  const linkedinUrl = normalizeProfileUrl(href);
  if (!linkedinUrl) return null;

  const cleaned = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const degreeLine = cleaned.find((line) => /[123](?:st|nd|rd)/i.test(line)) ?? null;
  const content = cleaned.filter(
    (line) => line !== degreeLine && !CARD_ACTION.test(line) && !/mutual connection/i.test(line)
  );
  const fullName = content[0] ?? null;
  if (!fullName) return null;
  const { title, company } = splitHeadline(content[1] ?? null);
  const { firstName, lastName } = splitName(fullName);

  return {
    salesNavUrn: linkedinUrl,
    salesNavUrl: "",
    linkedinUrl,
    fullName,
    firstName,
    lastName,
    title,
    company,
    location: content[2] ?? null,
    degree: parseDegree(degreeLine),
    objectUrn: null,
    summary: null,
    openLink: false,
    companyIndustry: null,
    companyLocation: null,
    tenureMonths: null,
    spotlightBadges: null,
  };
}

/** Pull people cards and the reported total out of a voyager search response. */
export function parsePeopleSearchPayload(payload: unknown): { profiles: ScrapedProfile[]; total: number } {
  const profiles: ScrapedProfile[] = [];
  const seen = new Set<string>();
  let total = 0;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.totalResultCount === "number" && obj.totalResultCount > total) {
      total = obj.totalResultCount;
    }
    if (isPeopleEntityResult(obj)) {
      const hit = resultFromEntity(obj);
      if (hit && !seen.has(hit.profile.linkedinUrl!)) {
        seen.add(hit.profile.linkedinUrl!);
        profiles.push(hit.profile);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };

  visit(payload);
  return { profiles, total };
}

function urnToSalesNavUrl(urn: string): string {
  const match = urn.match(/\(([^)]+)\)/);
  if (!match) return "";
  return `https://www.linkedin.com/sales/lead/${match[1]}`;
}

/**
 * Parse profileId, authType, authToken out of a salesProfile URN.
 * urn:li:fs_salesProfile:(ACwAAEIY-4YB25mKP6R5AKfkFjhO9isSbvsVlag,NAME_SEARCH,22wq)
 */
function parseUrn(entityUrn: string): { profileId: string; authType: string; authToken: string } | null {
  const match = entityUrn.match(/\(([^,]+),([^,]+),([^)]+)\)/);
  if (!match) return null;
  return { profileId: match[1], authType: match[2], authToken: match[3] };
}

function profileToResult(el: SalesProfile, linkedinUrl: string | null): ScrapedProfile {
  const currentPos = el.currentPositions?.find((p) => p.current) ?? el.currentPositions?.[0];
  const company = currentPos?.companyUrnResolutionResult ?? null;

  // Tenure in months at current position
  let tenureMonths: number | null = null;
  const t = currentPos?.tenureAtPosition;
  if (t) tenureMonths = (t.numYears ?? 0) * 12 + (t.numMonths ?? 0);

  // Spotlight badge labels as a compact JSON array e.g. ["Changed jobs", "Mentioned in news"]
  const badges = (el.spotlightBadges ?? [])
    .map((b) => b.displayValue)
    .filter(Boolean) as string[];

  return {
    salesNavUrn: el.entityUrn,
    salesNavUrl: urnToSalesNavUrl(el.entityUrn),
    linkedinUrl,
    fullName: el.fullName ?? null,
    firstName: el.firstName ?? null,
    lastName: el.lastName ?? null,
    title: currentPos?.title ?? null,
    company: el.leadAssociatedAccount?.name ?? company?.name ?? currentPos?.companyName ?? null,
    location: el.geoRegion ?? null,
    degree: el.degree ?? null,
    objectUrn: el.objectUrn ?? null,
    summary: el.summary ?? null,
    openLink: el.openLink ?? false,
    companyIndustry: company?.industry ?? null,
    companyLocation: company?.location ?? null,
    tenureMonths,
    spotlightBadges: badges.length > 0 ? JSON.stringify(badges) : null,
  };
}

/**
 * Enrich profiles with their real /in/ URL via salesApiProfiles (flagshipProfileUrl).
 *
 * Uses page.evaluate fetch with JSESSIONID csrf-token. On 429 (rate limit),
 * backs off for 30s and retries. Delay between calls: 2s normally, 30s after 429.
 *
 * For 100 profiles at 2s/call = ~3.5 minutes. Happens once at import time.
 */
async function enrichWithFlagshipUrls(
  page: Page,
  profiles: SalesProfile[],
  onProgress?: (p: ImportProgress) => void
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>(); // entityUrn → flagshipProfileUrl

  const cookies = await page.context().cookies("https://www.linkedin.com");
  const jsessionid = cookies.find(c => c.name === "JSESSIONID")?.value?.replace(/"/g, "") ?? "";
  if (!jsessionid) {
    console.log("[scraper] JSESSIONID not found — skipping flagshipProfileUrl enrichment");
    return urlMap;
  }

  let done = 0;
  for (const el of profiles) {
    const parts = parseUrn(el.entityUrn);
    if (!parts) continue;

    const { profileId, authType, authToken } = parts;
    const apiUrl = `https://www.linkedin.com/sales-api/salesApiProfiles/(profileId:${profileId},authType:${authType},authToken:${authToken})?decoration=%28entityUrn%2CflagshipProfileUrl%29`;

    let attempts = 0;
    while (attempts < 3) {
      const evaluatePromise = page.evaluate(async ({ url, csrfToken }: { url: string; csrfToken: string }) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const resp = await fetch(url, {
            credentials: "include",
            signal: controller.signal,
            headers: {
              "csrf-token": csrfToken,
              "x-restli-protocol-version": "2.0.0",
              "accept": "application/json",
            },
          });
          clearTimeout(timer);
          return { status: resp.status, body: await resp.text() };
        } catch (e: unknown) {
          return { status: -1, body: (e as Error).message };
        }
      }, { url: apiUrl, csrfToken: jsessionid });

      const timeoutPromise = new Promise<{ status: number; body: string }>((resolve) =>
        setTimeout(() => resolve({ status: -1, body: 'timeout' }), 15000)
      );
      const result = await Promise.race([evaluatePromise, timeoutPromise]);

      if (result.status === 200) {
        try {
          const data = JSON.parse(result.body) as ProfileDetailResponse;
          if (data.flagshipProfileUrl) {
            const normalized = data.flagshipProfileUrl.endsWith("/")
              ? data.flagshipProfileUrl
              : data.flagshipProfileUrl + "/";
            urlMap.set(el.entityUrn, normalized);
          }
        } catch { /* ignore parse errors */ }
        break;
      } else if (result.status === 429) {
        attempts++;
        console.log(`[scraper] 429 rate limit — waiting 30s before retry (attempt ${attempts}/3)`);
        await page.waitForTimeout(30000);
      } else {
        const reason = result.body === 'timeout' ? 'timeout' : result.status;
        console.log(`[scraper] enrichment ${reason} for ${el.fullName ?? el.entityUrn.substring(0, 30)} — skipping`);
        break;
      }
    }

    // 2s between calls — slow enough to stay under rate limits
    await page.waitForTimeout(2000);
    done++;
    console.log(`[scraper] flagship URLs: ${done}/${profiles.length} resolved`);
    onProgress?.({ phase: 'enriching', count: done, total: profiles.length });
  }

  console.log(`[scraper] enrichment done: ${urlMap.size}/${profiles.length} profiles resolved`);
  return urlMap;
}

export interface ImportProgress {
  phase: 'scraping' | 'enriching' | 'visiting';
  page?: number;
  totalPages?: number;
  count: number;
  total: number;
}

export interface ScrapeOptions {
  /** 1-based page to begin this window at (for batched imports). Default 1. */
  startPage?: number;
  /** Max pages to fetch in THIS window, starting at startPage. Default 50. */
  maxPages?: number;
  onProgress?: (p: ImportProgress) => void;
  /** Polled between pages; return true to stop early (cancel / deleted list). */
  isCanceled?: () => boolean | Promise<boolean>;
}

export interface WindowedScrapeResult {
  profiles: ScrapedProfile[];
  /** Last page actually fetched in this window. */
  lastPage: number;
  /** Total profiles available in the whole search. */
  knownTotal: number;
  /** True if this window reached the end of the search (nothing left to batch). */
  exhausted: boolean;
}

export async function scrapeNavigatorList(
  ctx: BrowserContext,
  salesNavUrl: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  const { startPage = 1, maxPages = 50, onProgress, isCanceled } = opts;
  const listId = extractListId(salesNavUrl);
  if (!listId) throw new Error(`Invalid Sales Navigator URL: ${salesNavUrl}`);

  const allElements: SalesProfile[] = [];
  const seen = new Set<string>();
  const PAGE_SIZE = 25;
  const buildUrl = (n: number) =>
    `https://www.linkedin.com/sales/lists/people/${listId}?${n > 1 ? `page=${n}&` : ""}sortCriteria=CREATED_TIME&sortOrder=DESCENDING`;

  const page = await ctx.newPage();
  let knownTotal = 0;
  let intercepted: FlatResponse | null = null;

  const waitForIntercept = async (url: string, waitMs: number): Promise<FlatResponse | null> => {
    intercepted = null;
    page.removeAllListeners("response");
    page.on("response", async (response) => {
      if (intercepted) return;
      if (response.url().includes("salesApiPeopleSearch") && response.status() === 200) {
        try { intercepted = await response.json() as FlatResponse; } catch { /* ignore */ }
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(waitMs);
    return intercepted;
  };

  // First page of the window
  const firstData = await waitForIntercept(buildUrl(startPage), 15000);
  if (!firstData) {
    const finalUrl = page.url();
    console.error(`[scraper] no intercept after 15s. Final URL: ${finalUrl}`);
    await page.close();
    throw new Error("No data intercepted from Sales Nav — session may need re-authentication");
  }

  knownTotal = firstData.paging?.total ?? 0;
  for (const el of firstData.elements ?? []) {
    if (!el.entityUrn || seen.has(el.entityUrn)) continue;
    seen.add(el.entityUrn);
    allElements.push(el);
  }
  console.log(`[scraper] page ${startPage}: ${allElements.length} elements, total=${knownTotal}`);

  const totalPages = Math.ceil(knownTotal / PAGE_SIZE);
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  let lastPage = startPage;
  onProgress?.({ phase: 'scraping', page: startPage, totalPages: endPage, count: allElements.length, total: knownTotal });

  for (let pageNum = startPage + 1; pageNum <= endPage; pageNum++) {
    if (isCanceled && (await isCanceled())) break;
    const delayMs = 60000 + Math.random() * 60000;
    console.log(`[scraper] waiting ${Math.round(delayMs / 1000)}s before page ${pageNum}...`);
    await page.waitForTimeout(delayMs);
    if (isCanceled && (await isCanceled())) break;

    let pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      console.log(`[scraper] page ${pageNum} empty on first try — retrying with 15s wait`);
      pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    }
    if (pageData) {
      for (const el of pageData.elements ?? []) {
        if (!el.entityUrn || seen.has(el.entityUrn)) continue;
        seen.add(el.entityUrn);
        allElements.push(el);
      }
    }
    lastPage = pageNum;
    console.log(`[scraper] page ${pageNum}/${endPage}: ${allElements.length} (total ${knownTotal})`);
    onProgress?.({ phase: 'scraping', page: pageNum, totalPages: endPage, count: allElements.length, total: knownTotal });
  }

  await page.close();
  return {
    profiles: allElements.map(el => profileToResult(el, null)),
    lastPage,
    knownTotal,
    exhausted: lastPage >= totalPages,
  };
}

export async function scrapeSavedSearch(
  ctx: BrowserContext,
  savedSearchUrl: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  const { startPage = 1, maxPages = 50, onProgress, isCanceled } = opts;
  const savedSearchId = extractSavedSearchId(savedSearchUrl);
  if (!savedSearchId) throw new Error(`Invalid Sales Navigator saved search URL: ${savedSearchUrl}`);

  const allElements: SalesProfile[] = [];
  const seen = new Set<string>();
  const PAGE_SIZE = 25;
  const buildUrl = (n: number) =>
    `https://www.linkedin.com/sales/search/people?savedSearchId=${savedSearchId}${n > 1 ? `&page=${n}` : ""}`;

  const page = await ctx.newPage();
  let knownTotal = 0;

  const waitForIntercept = async (url: string, waitMs: number): Promise<FlatResponse | null> => {
    let intercepted: FlatResponse | null = null;
    page.removeAllListeners("response");
    page.on("response", async (response) => {
      if (intercepted) return;
      if (response.url().includes("salesApiLeadSearch") && response.status() === 200) {
        try { intercepted = await response.json() as FlatResponse; } catch { /* ignore */ }
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(waitMs);
    return intercepted;
  };

  // First page of the window
  const firstData = await waitForIntercept(buildUrl(startPage), 15000);
  if (!firstData) {
    await page.close();
    throw new Error("No data intercepted from saved search — session may need re-authentication");
  }

  knownTotal = firstData.paging?.total ?? 0;
  for (const el of firstData.elements ?? []) {
    if (!el.entityUrn || seen.has(el.entityUrn)) continue;
    seen.add(el.entityUrn);
    allElements.push(el);
  }
  console.log(`[scraper:saved-search] page ${startPage}: ${allElements.length} elements, total=${knownTotal}`);

  const totalPages = Math.ceil(knownTotal / PAGE_SIZE);
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  let lastPage = startPage;
  onProgress?.({ phase: 'scraping', page: startPage, totalPages: endPage, count: allElements.length, total: knownTotal });

  for (let pageNum = startPage + 1; pageNum <= endPage; pageNum++) {
    if (isCanceled && (await isCanceled())) break;
    const delayMs = 60000 + Math.random() * 60000;
    console.log(`[scraper:saved-search] waiting ${Math.round(delayMs / 1000)}s before page ${pageNum}...`);
    await page.waitForTimeout(delayMs);
    if (isCanceled && (await isCanceled())) break;

    let pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      console.log(`[scraper:saved-search] page ${pageNum} empty on first try — retrying with 15s wait`);
      pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    }
    if (pageData) {
      for (const el of pageData.elements ?? []) {
        if (!el.entityUrn || seen.has(el.entityUrn)) continue;
        seen.add(el.entityUrn);
        allElements.push(el);
      }
    }
    lastPage = pageNum;
    console.log(`[scraper:saved-search] page ${pageNum}/${endPage}: ${allElements.length} (total ${knownTotal})`);
    onProgress?.({ phase: 'scraping', page: pageNum, totalPages: endPage, count: allElements.length, total: knownTotal });
  }

  await page.close();
  return {
    profiles: allElements.map(el => profileToResult(el, null)),
    lastPage,
    knownTotal,
    exhausted: lastPage >= totalPages,
  };
}

/**
 * Regular LinkedIn people search (/search/results/people). The page is 10
 * results and the cards arrive in the voyager search response.
 */
export async function scrapePeopleSearch(
  ctx: BrowserContext,
  searchUrl: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  const { startPage = 1, maxPages = 50, onProgress, isCanceled } = opts;
  if (!isLinkedInPeopleSearchUrl(searchUrl)) {
    throw new Error(`Invalid LinkedIn people search URL: ${searchUrl}`);
  }

  const allProfiles: ScrapedProfile[] = [];
  const seen = new Set<string>();
  // LinkedIn's people search URL paginates 10 results per page.
  const pageSize = 10;

  const page = await ctx.newPage();
  let knownTotal = 0;

  const readPeopleFromDom = async (): Promise<ScrapedProfile[]> => {
    const cards = await page.evaluate(() => {
      const found: { href: string; lines: string[] }[] = [];
      const seen = new Set<string>();
      for (const anchor of Array.from(document.querySelectorAll("a[href*='/in/']"))) {
        if (anchor.closest("header, nav, footer")) continue;
        const href = (anchor as HTMLAnchorElement).href;
        let slug = "";
        try {
          const match = new URL(href).pathname.match(/^\/in\/([^/]+)\/?$/);
          if (!match) continue;
          slug = decodeURIComponent(match[1]);
        } catch {
          continue;
        }
        if (seen.has(slug)) continue;
        seen.add(slug);
        const card = anchor.closest("li") || anchor.closest("[data-view-name]") || anchor.parentElement?.parentElement;
        const lines = (card?.textContent || "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line.length < 180)
          .slice(0, 8);
        found.push({ href: `https://www.linkedin.com/in/${slug}/`, lines });
      }
      return found;
    });
    return cards
      .map((card) => profileFromSearchCard(card.href, card.lines))
      .filter((profile): profile is ScrapedProfile => profile !== null);
  };

  const waitForIntercept = async (url: string, waitMs: number): Promise<{ profiles: ScrapedProfile[]; total: number; loggedOut: boolean }> => {
    let best: { profiles: ScrapedProfile[]; total: number } | null = null;
    page.removeAllListeners("response");
    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (response.status() !== 200) return;
      if (!/voyagerSearchDashClusters|search\/dash\/clusters|voyager\/api\/graphql|voyager\/api\/search/.test(responseUrl)) return;
      try {
        const parsed = parsePeopleSearchPayload(await response.json());
        if (parsed.profiles.length === 0 && parsed.total === 0) return;
        if (!best || parsed.profiles.length > best.profiles.length) best = parsed;
      } catch { /* non-json or unrelated graphql */ }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (/login|checkpoint|authwall|uas\/login/i.test(page.url())) {
      return { profiles: [], total: 0, loggedOut: true };
    }
    await page.waitForSelector("a[href*='/in/']", { timeout: waitMs }).catch(() => {});
    await page.waitForTimeout(1500);
    const domProfiles = await readPeopleFromDom();
    const profiles = best?.profiles.length ? best.profiles : domProfiles;
    return { profiles, total: best?.total ?? 0, loggedOut: false };
  };

  const take = (parsed: { profiles: ScrapedProfile[]; total: number; loggedOut?: boolean } | null) => {
    if (!parsed) return 0;
    if (parsed.total > knownTotal) knownTotal = parsed.total;
    let added = 0;
    for (const profile of parsed.profiles) {
      const key = profile.linkedinUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allProfiles.push(profile);
      added++;
    }
    return added;
  };

  const first = await waitForIntercept(peopleSearchPageUrl(searchUrl, startPage), 15000);
  if (first.loggedOut || first.profiles.length === 0) {
    const finalUrl = page.url();
    await page.close();
    if (first.loggedOut || /login|checkpoint|authwall|uas\/login/i.test(finalUrl)) {
      throw new Error("No data intercepted from LinkedIn search — session may need re-authentication");
    }
    throw new Error("No people were returned for this LinkedIn search. Check the filters, or re-authenticate the LinkedIn account.");
  }

  take(first);
  console.log(`[scraper:people] page ${startPage}: ${allProfiles.length} profiles, total=${knownTotal}`);

  const totalPages = knownTotal > 0 ? Math.ceil(knownTotal / pageSize) : startPage + maxPages - 1;
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  let lastPage = startPage;
  onProgress?.({ phase: "scraping", page: startPage, totalPages: endPage, count: allProfiles.length, total: knownTotal || allProfiles.length });

  for (let pageNum = startPage + 1; pageNum <= endPage; pageNum++) {
    if (isCanceled && (await isCanceled())) break;
    const delayMs = 60000 + Math.random() * 60000;
    console.log(`[scraper:people] waiting ${Math.round(delayMs / 1000)}s before page ${pageNum}...`);
    await page.waitForTimeout(delayMs);
    if (isCanceled && (await isCanceled())) break;

    let pageData = await waitForIntercept(peopleSearchPageUrl(searchUrl, pageNum), 15000);
    if (!pageData || pageData.profiles.length === 0) {
      console.log(`[scraper:people] page ${pageNum} empty on first try — retrying with 15s wait`);
      pageData = await waitForIntercept(peopleSearchPageUrl(searchUrl, pageNum), 15000);
    }
    const added = take(pageData);
    lastPage = pageNum;
    if (added === 0) {
      console.log(`[scraper:people] page ${pageNum} added nothing — stopping`);
      break;
    }
    console.log(`[scraper:people] page ${pageNum}/${endPage}: ${allProfiles.length} (total ${knownTotal})`);
    onProgress?.({ phase: "scraping", page: pageNum, totalPages: endPage, count: allProfiles.length, total: knownTotal || allProfiles.length });
  }

  await page.close();
  const exhausted = knownTotal > 0 ? lastPage >= Math.ceil(knownTotal / pageSize) : lastPage < endPage;
  return {
    profiles: allProfiles,
    lastPage,
    knownTotal: knownTotal || allProfiles.length,
    exhausted,
  };
}

/**
 * Dispatcher — Sales Nav list, Sales Nav saved search, or a regular LinkedIn people search.
 */
export async function scrapeNavigatorUrl(
  ctx: BrowserContext,
  url: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  if (extractSavedSearchId(url)) {
    return scrapeSavedSearch(ctx, url, opts);
  }
  if (extractListId(url)) {
    return scrapeNavigatorList(ctx, url, opts);
  }
  if (isLinkedInPeopleSearchUrl(url)) {
    return scrapePeopleSearch(ctx, url, opts);
  }
  throw new Error(`Unrecognized LinkedIn URL. Use a people search (/search/results/people/...), a Sales Navigator list (/sales/lists/people/...), or a saved search (?savedSearchId=...).`);
}
