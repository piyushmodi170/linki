import type { NextApiRequest, NextApiResponse } from "next";
import { verifyLinkedInSession } from "@/lib/linkedin/session";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const id = req.query.id as string;
  try {
    const result = await verifyLinkedInSession(id);
    return res.json(result);
  } catch (err) {
    console.error("[linkedin-verify]", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Verify failed" });
  }
}
