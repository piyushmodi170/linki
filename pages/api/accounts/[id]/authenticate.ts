import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { storageStateFromPaste } from "@/lib/linkedin/cookie-paste";
import { describeSavedSession } from "@/lib/linkedin/identity";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const { li_at, document_cookie } = req.body as { li_at?: string; document_cookie?: string };
  if (!li_at) return res.status(400).json({ error: "li_at cookie is required" });

  const built = storageStateFromPaste(li_at, document_cookie);
  if (!built.ok) return res.status(400).json({ error: built.error });
  const storageState = built.state;

  // Store only. Contacting LinkedIn with these cookies revokes li_at and
  // signs the person out of the browser they copied them from.
  const identity = describeSavedSession(storageState.cookies);
  if (!identity.connected) return res.status(400).json({ error: identity.message });

  db.prepare(
    `UPDATE accounts
        SET cookies_json = ?, is_authenticated = 1,
            li_profile_name = NULL, li_profile_headline = NULL, li_profile_photo = NULL
      WHERE id = ?`
  ).run(encryptSecret(JSON.stringify(storageState)), id);

  const { closeSession } = await import("@/lib/linkedin/session");
  await closeSession(id);

  return res.json({ ok: true, contactedLinkedIn: false, message: identity.message });
}
