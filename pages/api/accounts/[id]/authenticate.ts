import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { storageStateFromPaste } from "@/lib/linkedin/cookie-paste";
import { fetchLinkedInIdentity } from "@/lib/linkedin/identity";

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

  // Identify the account over HTTP. Do not open a browser: that revokes li_at.
  const identity = await fetchLinkedInIdentity(storageState.cookies);
  if (!identity.connected || !identity.profile) {
    return res.status(400).json({ error: identity.message });
  }

  db.prepare(
    `UPDATE accounts
        SET cookies_json = ?, is_authenticated = 0,
            li_profile_name = ?, li_profile_headline = ?, li_profile_photo = ?
      WHERE id = ?`
  ).run(
    encryptSecret(JSON.stringify(storageState)),
    identity.profile.fullName,
    identity.profile.headline,
    identity.profile.photoUrl,
    id
  );

  const { closeSession } = await import("@/lib/linkedin/session");
  await closeSession(id);

  return res.json({ ok: true, profile: identity.profile });
}
