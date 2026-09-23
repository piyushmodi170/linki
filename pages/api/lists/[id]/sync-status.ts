import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { isLinkedInPeopleSearchUrl } from "@/lib/linkedin/scraper";

// POST /api/lists/[id]/sync-status  body: { account_id: number }
// Re-fetches the Sales Nav list and updates degree for non-connected targets.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const db = getDb();
  const listId = req.query.id as string;

  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(listId) as
    | { sales_nav_url?: string }
    | undefined;
  if (!list) return res.status(404).json({ error: "List not found" });
  if (!list.sales_nav_url) return res.status(400).json({ error: "No Sales Navigator URL saved for this list — run an import first" });

  const { account_id } = req.body as { account_id: string };
  if (!account_id) return res.status(400).json({ error: "account_id required" });

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(account_id) as
    | { cookies_json: string | null; is_authenticated: number }
    | undefined;
  if (!account?.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  const { insertProfiles, startImport } = await import("@/lib/import-jobs");

  try {
    const peopleSearch = isLinkedInPeopleSearchUrl(list.sales_nav_url);
    const { profiles, exhausted } = peopleSearch
      ? await (async () => {
          const { decryptSecret } = await import("@/lib/crypto");
          const { normalizeStorageState } = await import("@/lib/linkedin/cookie-paste");
          const { scrapePeopleSearchHttp } = await import("@/lib/linkedin/people-search-http");
          const parsed = JSON.parse(decryptSecret(account.cookies_json ?? "") ?? "");
          const cookies = normalizeStorageState(parsed).state.cookies;
          return scrapePeopleSearchHttp(cookies, list.sales_nav_url!);
        })()
      : await (async () => {
          const { getSessionContext } = await import("@/lib/linkedin/session");
          const { scrapeNavigatorUrl } = await import("@/lib/linkedin/scraper");
          const ctx = await getSessionContext(account_id);
          return scrapeNavigatorUrl(ctx, list.sales_nav_url!, { maxPages: 300 });
        })();
    const { imported, skipped } = insertProfiles(db, listId, profiles);

    const markConnected = db.prepare(
      `UPDATE targets SET degree = ?, connected_at = CASE
         WHEN (degree IS NULL OR degree != 1) AND connected_at IS NULL THEN datetime('now')
         ELSE connected_at
       END
       WHERE linkedin_url = ?`
    );
    db.transaction(() => {
      for (const p of profiles) {
        if (p.degree !== 1) continue;
        const url = p.linkedinUrl || p.salesNavUrl;
        if (url) markConnected.run(p.degree, url);
      }
    })();

    if (peopleSearch && !exhausted) {
      startImport(db, { listId, accountId: account_id, salesNavUrl: list.sales_nav_url });
    }

    return res.json({ updated: profiles.length, total: profiles.length, imported, skipped });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/re-authentication|login page|No data intercepted/i.test(message)) {
      try {
        const { markNeedsReauth } = await import("@/lib/linkedin/session");
        await markNeedsReauth(account_id);
      } catch { /* ignore */ }
    }
    return res.status(500).json({ error: message });
  }
}

export const config = {
  api: { responseLimit: false },
};
