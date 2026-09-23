// Local reading of a pasted LinkedIn cookie jar.
// Do not send these cookies to LinkedIn from this server. LinkedIn treats that
// as a second login and revokes li_at, which signs the person out of the
// browser they copied the cookie from.

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

/** Whether the saved jar contains a usable li_at. Never contacts LinkedIn. */
export function describeSavedSession(cookies: PlaywrightCookie[]): LinkedInIdentityResult {
  const now = Date.now() / 1000;
  const liAt = cookies.find((cookie) => cookie.name === "li_at" && cookie.value);
  if (!liAt) {
    return {
      connected: false,
      message: "Saved cookies do not include li_at. Paste the li_at cookie or a Cookie-Editor export.",
      profile: null,
    };
  }
  if (typeof liAt.expires === "number" && liAt.expires > 0 && liAt.expires < now) {
    return {
      connected: false,
      message: "The saved li_at cookie is expired. Sign in on LinkedIn and export a new cookie file.",
      profile: null,
    };
  }
  return {
    connected: true,
    message: "Cookies are stored on this server only. LinkedIn was not contacted, so the browser you copied them from stays signed in.",
    profile: null,
  };
}
