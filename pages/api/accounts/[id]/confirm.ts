import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

// POST /api/accounts/[id]/confirm  body: { accept: boolean }
// The cookie paste already fetched the LinkedIn profile. This records whether
// that profile is the account the user meant to connect.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;
  const account = db.prepare("SELECT id, cookies_json FROM accounts WHERE id = ?").get(id) as
    | { id: string; cookies_json: string | null }
    | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });

  const accept = (req.body as { accept?: boolean })?.accept === true;
  if (!accept) {
    db.prepare(
      `UPDATE accounts
          SET cookies_json = NULL, is_authenticated = 0,
              li_profile_name = NULL, li_profile_headline = NULL, li_profile_photo = NULL
        WHERE id = ?`
    ).run(id);
    return res.json({ ok: true, connected: false });
  }

  if (!account.cookies_json) {
    return res.status(400).json({ error: "No cookies to confirm. Paste them again." });
  }

  db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(id);
  return res.json({ ok: true, connected: true });
}
