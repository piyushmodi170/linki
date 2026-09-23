import { scrapePeopleSearchHttp } from "../lib/linkedin/people-search-http";

const BLOCKED = "Blocked before contacting LinkedIn";

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
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches += 1;
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (!cookie.includes("li_at=AQ-AUDIT-NOT-A-REAL-SESSION")) {
      throw new Error("expected the fake cookie");
    }
    if (!String(input).includes("linkedin.com/search/results/people")) {
      throw new Error(`unexpected url ${String(input)}`);
    }
    return new Response("<html><title>People</title><main></main></html>", { status: 200 });
  }) as typeof fetch;

  let message = "";
  try {
    await scrapePeopleSearchHttp(fakeCookies, searchUrl);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (fetches !== 1) throw new Error(`people search did not contact the results page (fetches=${fetches})`);
  if (message.includes(BLOCKED)) throw new Error("people search is still blocked before contacting LinkedIn");

  fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(null, {
      status: 302,
      headers: { location: searchUrl },
    });
  }) as typeof fetch;
  message = "";
  try {
    await scrapePeopleSearchHttp(fakeCookies, searchUrl);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (fetches < 1) throw new Error("redirect was not requested");
  if (message.includes(BLOCKED)) throw new Error("redirect is still blocked before contacting LinkedIn");
  if (!message.includes("login page")) throw new Error(`expected a login result, got: ${message}`);
  console.log("people search fetches the results page and does not return the blocked error");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
