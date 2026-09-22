// Cookie-Editor and EditThisCookie export a JSON array. Pasting that whole
// export into the li_at field stores it as one cookie value, which Chromium
// rejects ("Invalid cookie fields") because the value is huge and contains
// spaces and quotes. Detect that shape and turn it into real cookies.

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface LinkedInStorageState {
  cookies: PlaywrightCookie[];
  origins: unknown[];
}

function mapSameSite(value: unknown): "Strict" | "Lax" | "None" {
  const s = String(value ?? "").toLowerCase().replace(/[\s_-]/g, "");
  if (s === "norestriction" || s === "none") return "None";
  if (s === "strict") return "Strict";
  return "Lax";
}

function isCookieRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

function toPlaywrightCookie(cookie: Record<string, unknown>): PlaywrightCookie {
  let domain = typeof cookie.domain === "string" && cookie.domain ? cookie.domain : ".linkedin.com";
  if (cookie.hostOnly === true && domain.startsWith(".")) domain = domain.slice(1);

  const expiration =
    typeof cookie.expirationDate === "number"
      ? cookie.expirationDate
      : typeof cookie.expires === "number"
        ? cookie.expires
        : null;
  const session = cookie.session === true || expiration == null || expiration < 0;
  const sameSite = mapSameSite(cookie.sameSite);

  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain,
    path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
    expires: session ? -1 : Math.floor(expiration as number),
    httpOnly: cookie.httpOnly === true,
    secure: sameSite === "None" ? true : cookie.secure !== false,
    sameSite,
  };
}

function dedupe(cookies: PlaywrightCookie[]): PlaywrightCookie[] {
  const byKey = new Map<string, PlaywrightCookie>();
  for (const cookie of cookies) {
    if (!cookie.name) continue;
    byKey.set(`${cookie.name}\0${cookie.domain}\0${cookie.path}`, cookie);
  }
  return [...byKey.values()];
}

/** Cookie-Editor / EditThisCookie JSON, or a Playwright `{ cookies }` blob. */
export function parseCookieExport(raw: string): PlaywrightCookie[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!list || list.length === 0 || !list.every(isCookieRecord)) return null;
  return dedupe(list.map(toPlaywrightCookie));
}

function documentCookiePairs(documentCookie: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  for (const part of documentCookie.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!name || !value) continue;
    cookies.push({
      name,
      value,
      domain: ".linkedin.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return cookies;
}

export function storageStateFromPaste(
  liAt: string,
  documentCookie?: string
): { ok: true; state: LinkedInStorageState } | { ok: false; error: string } {
  const fromLiAt = parseCookieExport(liAt);
  const fromDocument = documentCookie?.trim() ? parseCookieExport(documentCookie) : null;

  if (fromLiAt || fromDocument) {
    const cookies = dedupe([...(fromLiAt ?? []), ...(fromDocument ?? [])]);
    if (!cookies.some((cookie) => cookie.name === "li_at")) {
      return { ok: false, error: "That cookie export has no li_at cookie. Export the cookies for linkedin.com and paste them again." };
    }
    return { ok: true, state: { cookies, origins: [] } };
  }

  const value = liAt.trim();
  if (!value) return { ok: false, error: "li_at cookie is required" };
  if (value.length > 2000 || /[\s"]/.test(value)) {
    return {
      ok: false,
      error: "That is not an li_at value. Paste only the li_at cookie, or paste a Cookie-Editor JSON export.",
    };
  }

  const cookies = dedupe([
    {
      name: "li_at",
      value,
      domain: ".linkedin.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "None" as const,
    },
    ...(documentCookie ? documentCookiePairs(documentCookie).filter((cookie) => cookie.name !== "li_at") : []),
  ]);

  return { ok: true, state: { cookies, origins: [] } };
}

/**
 * Repair a stored Playwright storage state whose cookie value is actually a
 * cookie-export JSON blob. Returns the original state when nothing is nested.
 */
export function normalizeStorageState(state: unknown): { changed: boolean; state: LinkedInStorageState } {
  const cookies = state && typeof state === "object" && Array.isArray((state as { cookies?: unknown }).cookies)
    ? (state as { cookies: unknown[] }).cookies
    : [];

  let changed = false;
  const out: PlaywrightCookie[] = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") continue;
    const value = (cookie as { value?: unknown }).value;
    if (typeof value === "string") {
      const exported = parseCookieExport(value);
      if (exported) {
        out.push(...exported);
        changed = true;
        continue;
      }
    }
    if (isCookieRecord(cookie) && typeof (cookie as { domain?: unknown }).domain === "string") {
      out.push(toPlaywrightCookie(cookie));
    }
  }

  if (!changed) return { changed: false, state: state as LinkedInStorageState };

  const origins =
    state && typeof state === "object" && Array.isArray((state as { origins?: unknown }).origins)
      ? (state as { origins: unknown[] }).origins
      : [];
  return { changed: true, state: { cookies: dedupe(out), origins } };
}
