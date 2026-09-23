// Checks a pasted LinkedIn session with a single API request.
// Opening those cookies in a second browser makes LinkedIn revoke li_at and
// sign the person out everywhere, including the browser they copied from.

import type { PlaywrightCookie } from "@/lib/linkedin/cookie-paste";

export interface LinkedInProfileCard {
  fullName: string;
  headline: string | null;
  photoUrl: string | null;
  publicIdentifier: string | null;
}

export interface LinkedInIdentityResult {
  connected: boolean;
  message: string;
  profile: LinkedInProfileCard | null;
}

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cookieSentToLinkedIn(cookie: PlaywrightCookie, nowSeconds: number): boolean {
  if (!cookie.name || cookie.value == null || cookie.value === "") return false;
  if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires < nowSeconds) return false;
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  if (domain !== "linkedin.com" && !domain.endsWith(".linkedin.com")) return false;
  const path = cookie.path || "/";
  return path === "/" || "/".startsWith(path);
}

/** Cookie header for www.linkedin.com. One value per name; a www-scoped cookie wins. */
export function linkedInCookieHeader(cookies: PlaywrightCookie[], nowSeconds = Date.now() / 1000): string {
  const chosen = new Map<string, PlaywrightCookie>();
  for (const cookie of cookies) {
    if (!cookieSentToLinkedIn(cookie, nowSeconds)) continue;
    const prev = chosen.get(cookie.name);
    const specific = cookie.domain.includes("www.linkedin.com");
    if (!prev || (specific && !prev.domain.includes("www.linkedin.com"))) chosen.set(cookie.name, cookie);
  }
  return [...chosen.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function csrfToken(cookies: PlaywrightCookie[]): string {
  const raw = cookies.find((cookie) => cookie.name === "JSESSIONID")?.value ?? "";
  return raw.replace(/^"|"$/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pictureUrl(picture: unknown): string | null {
  const root = asRecord(picture);
  if (!root) return null;
  const vector =
    asRecord(root["com.linkedin.common.VectorImage"]) ??
    asRecord(asRecord(root.displayImageReference)?.vectorImage) ??
    asRecord(root.vectorImage) ??
    root;
  const rootUrl = typeof vector.rootUrl === "string" ? vector.rootUrl : null;
  const artifacts = Array.isArray(vector.artifacts) ? vector.artifacts : [];
  let best: { width: number; path: string } | null = null;
  for (const artifact of artifacts) {
    const item = asRecord(artifact);
    if (!item || typeof item.fileIdentifyingUrlPathSegment !== "string") continue;
    const width = typeof item.width === "number" ? item.width : 0;
    if (!best || width > best.width) best = { width, path: item.fileIdentifyingUrlPathSegment };
  }
  if (rootUrl && best) return `${rootUrl}${best.path}`;
  if (typeof vector.url === "string") return vector.url;
  return null;
}

/** Pull the signed-in member out of a voyager /me payload. */
export function profileFromMePayload(payload: unknown): LinkedInProfileCard | null {
  let firstName: string | null = null;
  let lastName: string | null = null;
  let headline: string | null = null;
  let publicIdentifier: string | null = null;
  let photoUrl: string | null = null;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const name = typeof obj.firstName === "string" ? obj.firstName.trim() : "";
    const surname = typeof obj.lastName === "string" ? obj.lastName.trim() : null;
    if (name && surname !== null && !firstName) {
      firstName = name;
      lastName = surname;
      const occupation = typeof obj.occupation === "string" ? obj.occupation : typeof obj.headline === "string" ? obj.headline : null;
      headline = occupation?.trim() || null;
      publicIdentifier = typeof obj.publicIdentifier === "string" ? obj.publicIdentifier : null;
      photoUrl = pictureUrl(obj.picture) ?? pictureUrl(obj.profilePicture);
    }
    for (const value of Object.values(obj)) visit(value);
  };

  visit(payload);
  if (!firstName) return null;
  return {
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    headline,
    photoUrl,
    publicIdentifier,
  };
}

export async function fetchLinkedInIdentity(cookies: PlaywrightCookie[]): Promise<LinkedInIdentityResult> {
  if (!cookies.some((cookie) => cookie.name === "li_at" && cookie.value)) {
    return { connected: false, message: "Saved cookies do not include li_at. Paste the li_at cookie or a Cookie-Editor export.", profile: null };
  }

  const cookieHeader = linkedInCookieHeader(cookies);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://www.linkedin.com/voyager/api/me", {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.linkedin.normalized+json+2.1",
        "csrf-token": csrfToken(cookies),
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "user-agent": CHROME_UA,
        cookie: cookieHeader,
      },
    });

    if (response.status !== 200) {
      return {
        connected: false,
        message: "LinkedIn did not accept these cookies. Stay signed in on LinkedIn, export a fresh Cookie-Editor JSON, and paste it again.",
        profile: null,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { connected: false, message: "LinkedIn did not return an account profile for these cookies.", profile: null };
    }

    const profile = profileFromMePayload(payload);
    if (!profile) {
      return { connected: false, message: "LinkedIn accepted the request but did not return a profile.", profile: null };
    }
    return { connected: true, message: `Connected as ${profile.fullName}.`, profile };
  } catch {
    return { connected: false, message: "Could not reach LinkedIn to check these cookies. Try again in a moment.", profile: null };
  } finally {
    clearTimeout(timer);
  }
}
