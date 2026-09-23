import { scrapePeopleSearchHttp } from "../lib/linkedin/people-search-http";
import {
  LINKEDIN_REMOTE_BLOCKED_MESSAGE,
  assertLinkedInRemoteAllowed,
  isLinkedInRemoteBlocked,
} from "../lib/linkedin/remote-guard";

const fakeCookies = [
  {
    name: "li_at",
    value: "AQ-AUDIT-NOT-A-REAL-SESSION",
    domain: ".www.linkedin.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
];

const searchUrl = "https://www.linkedin.com/search/results/people/?keywords=audit";

async function main() {
  delete process.env.LINKEDIN_REMOTE;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("fetch should not run while LinkedIn remote use is blocked");
  }) as typeof fetch;

  let blocked = false;
  try {
    await scrapePeopleSearchHttp(fakeCookies, searchUrl);
  } catch (err) {
    blocked = isLinkedInRemoteBlocked(err);
    if (!blocked) throw err;
  }
  if (!blocked) throw new Error("people search was not blocked");
  if (fetches !== 0) throw new Error(`people search contacted LinkedIn ${fetches} time(s) while blocked`);

  try {
    assertLinkedInRemoteAllowed();
    throw new Error("guard did not throw");
  } catch (err) {
    if (!isLinkedInRemoteBlocked(err)) throw err;
    if ((err as Error).message !== LINKEDIN_REMOTE_BLOCKED_MESSAGE) {
      throw new Error("blocked message changed");
    }
  }

  process.env.LINKEDIN_REMOTE = "1";
  fetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches += 1;
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (!cookie.includes("li_at=AQ-AUDIT-NOT-A-REAL-SESSION")) {
      throw new Error("expected the fake cookie, not a saved session");
    }
    if (String(input).includes("linkedin.com") === false) {
      throw new Error(`unexpected url ${String(input)}`);
    }
    return new Response("blocked by test", { status: 200 });
  }) as typeof fetch;

  let reachedNetwork = false;
  try {
    await scrapePeopleSearchHttp(fakeCookies, searchUrl);
  } catch (err) {
    reachedNetwork = fetches === 1;
    if (!reachedNetwork) throw err;
  }
  if (fetches !== 1) throw new Error(`expected exactly one mocked fetch, saw ${fetches}`);

  globalThis.fetch = originalFetch;
  delete process.env.LINKEDIN_REMOTE;
  console.log("linkedin remote guard: blocked with 0 fetches; opt-in reaches fetch with the fake cookie only");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
