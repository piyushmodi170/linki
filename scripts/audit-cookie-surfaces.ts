/**
 * Exercises every user-facing path that can present saved LinkedIn cookies.
 * Swaps the stored jar for a fake one first, so a missed guard cannot send
 * the real session. Restores the original jar in a finally block.
 *
 * Prints status lines only. Never prints cookie values, secrets, or emails.
 */
import { execSync } from "node:child_process";
import { encode } from "next-auth/jwt";
import Database from "better-sqlite3";

const DB_PATH = "/workspace/data/linki.db";
const BASE = "http://127.0.0.1:3000";
const BLOCKED = "Blocked before contacting LinkedIn";
const FAKE_JAR = JSON.stringify({
  cookies: [
    {
      name: "li_at",
      value: "AQ-AUDIT-NOT-A-REAL-SESSION",
      domain: ".www.linkedin.com",
      path: "/",
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
  ],
  origins: [],
});

type Row = {
  action: string;
  result: string;
  ms: number;
  chrome: number;
  external: number;
};

const rows: Row[] = [];

function chromeCount(): number {
  const out = execSync("ps -eo args", { encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.includes("chrome-headless-shell") && !line.includes("ps -eo")).length;
}

function externalConnections(): number {
  const remotes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = execSync(`cat ${path}`, { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4 || parts[3] !== "01") continue;
      const remote = parts[2] ?? "";
      const ip = remote.split(":")[0] ?? "";
      if (!ip || ip === "00000000" || ip === "0100007F" || ip === "00000000000000000000000000000000" || ip === "0000000000000000000000000100007F") {
        continue;
      }
      remotes.add(remote);
    }
  }
  return remotes.size;
}

async function hit(
  action: string,
  path: string,
  init: RequestInit | undefined,
  cookie: string,
  expect: "local" | "blocked"
): Promise<string> {
  const chromeBefore = chromeCount();
  const extBefore = externalConnections();
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      cookie: `next-auth.session-token=${cookie}`,
    },
  });
  const text = await res.text();
  const ms = Date.now() - started;
  const chrome = Math.max(chromeCount() - chromeBefore, 0);
  const external = Math.max(externalConnections() - extBefore, 0);
  let body: { error?: string; message?: string; contactedLinkedIn?: boolean; connected?: boolean; started?: boolean; status?: string } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  const detail = body.error || body.message || text.slice(0, 120);
  const blocked = detail.includes(BLOCKED) || text.includes(BLOCKED);
  const leaked = text.includes("AQ-AUDIT") || text.includes("li_at=");
  let result: string;
  if (expect === "blocked") {
    result =
      blocked && res.status === 500 && chrome === 0 && !leaked
        ? `BLOCKED ${res.status}`
        : `FAIL ${res.status} chrome=${chrome} ext=${external} ${detail.slice(0, 160)}`;
  } else {
    result =
      res.ok && !blocked && chrome === 0 && !leaked
        ? `LOCAL ${res.status}${body.contactedLinkedIn === false ? " contactedLinkedIn=false" : ""}`
        : `FAIL ${res.status} chrome=${chrome} ext=${external} blocked=${blocked} leaked=${leaked} ${detail.slice(0, 120)}`;
  }
  rows.push({ action, result, ms, chrome, external });
  return text;
}

async function waitForImport(listId: string, cookie: string, label: string) {
  const chromeBefore = chromeCount();
  const extBefore = externalConnections();
  const started = Date.now();
  let last = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${BASE}/api/lists/${listId}/import-status`, {
      headers: { cookie: `next-auth.session-token=${cookie}` },
    });
    last = await res.text();
    if (last.includes(BLOCKED) || /"status":"error"/.test(last) || /"status":"done"/.test(last)) break;
  }
  const ms = Date.now() - started;
  const chrome = Math.max(chromeCount() - chromeBefore, 0);
  const external = Math.max(externalConnections() - extBefore, 0);
  const blocked = last.includes(BLOCKED);
  const result =
    blocked && chrome === 0
      ? "BLOCKED before send"
      : `FAIL chrome=${chrome} ext=${external} ${last.slice(0, 180)}`;
  rows.push({ action: label, result, ms, chrome, external });
}

async function main() {
  if (!process.env.NEXTAUTH_SECRET) throw new Error("NEXTAUTH_SECRET missing");
  const db = new Database(DB_PATH);
  const user = db.prepare("SELECT id, email FROM users LIMIT 1").get() as { id: string; email: string };
  const account = db.prepare("SELECT id, cookies_json, is_authenticated FROM accounts LIMIT 1").get() as {
    id: string;
    cookies_json: string;
    is_authenticated: number;
  };
  const originalCookies = account.cookies_json;
  const originalAuth = account.is_authenticated;
  const token = await encode({
    token: { sub: user.id, email: user.email },
    secret: process.env.NEXTAUTH_SECRET,
  });

  const target = db.prepare("SELECT id FROM targets WHERE sales_nav_url IS NOT NULL LIMIT 1").get() as { id: string } | undefined;

  try {
    db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(FAKE_JAR, account.id);

    const pages = ["/", "/settings", "/lists", "/workflows", "/contacts", "/inbox", "/companies", "/email-health"];
    for (const path of pages) {
      await hit(`open ${path}`, path, { method: "GET" }, token, "local");
    }

    await hit("GET /api/accounts", "/api/accounts", { method: "GET" }, token, "local");
    await hit("GET /api/premium-status", "/api/premium-status", { method: "GET" }, token, "local");
    await hit("GET /api/dashboard/stats", "/api/dashboard/stats", { method: "GET" }, token, "local");
    await hit("GET /api/imports", "/api/imports", { method: "GET" }, token, "local");
    await hit("POST verify", `/api/accounts/${account.id}/verify`, { method: "POST" }, token, "local");
    await hit(
      "POST save cookies",
      `/api/accounts/${account.id}/authenticate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ li_at: FAKE_JAR }),
      },
      token,
      "local"
    );
    await hit(
      "POST confirm accept",
      `/api/accounts/${account.id}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      },
      token,
      "local"
    );

    await hit("POST dashboard Sync stats", `/api/accounts/${account.id}/li-stats`, { method: "POST" }, token, "blocked");
    await hit("POST sync accepted", `/api/accounts/${account.id}/sync-accepted`, { method: "POST" }, token, "blocked");
    await hit(
      "POST server login",
      `/api/accounts/${account.id}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "start", email: "audit@example.com", password: "not-a-real-password" }),
      },
      token,
      "blocked"
    );
    await hit(
      "POST login code",
      `/api/accounts/${account.id}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "verify", code: "000000" }),
      },
      token,
      "blocked"
    );
    await hit(
      "POST login app approval",
      `/api/accounts/${account.id}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "await" }),
      },
      token,
      "blocked"
    );

    if (target) {
      db.prepare("UPDATE targets SET sales_nav_url = ? WHERE id = ?").run(
        "https://www.linkedin.com/sales/lead/audit",
        target.id
      );
      try {
        await hit(
          "POST profile scrape",
          `/api/targets/${target.id}/profile-scrape`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          token,
          "blocked"
        );
      } finally {
        db.prepare("UPDATE targets SET sales_nav_url = '' WHERE id = ?").run(target.id);
      }
    }

    const created = await fetch(`${BASE}/api/lists`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `next-auth.session-token=${token}` },
      body: JSON.stringify({ name: "cookie-kill audit", description: "temporary" }),
    });
    const list = (await created.json()) as { id: string };
    if (!list.id) throw new Error("could not create temporary list");

    const peopleUrl = "https://www.linkedin.com/search/results/people/?keywords=audit";
    await hit(
      "POST people-search import (queue)",
      `/api/lists/${list.id}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sales_nav_url: peopleUrl, account_id: account.id }),
      },
      token,
      "local"
    );
    await waitForImport(list.id, token, "runner people-search import");

    await hit(
      "POST people-search sync",
      `/api/lists/${list.id}/sync-status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      },
      token,
      "blocked"
    );

    const salesUrl = "https://www.linkedin.com/sales/lists/people/1";
    await hit(
      "POST sales-nav import (queue)",
      `/api/lists/${list.id}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sales_nav_url: salesUrl, account_id: account.id }),
      },
      token,
      "local"
    );
    await waitForImport(list.id, token, "runner sales-nav import");

    await hit(
      "POST list enrich",
      `/api/lists/${list.id}/enrich`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      },
      token,
      "blocked"
    );

    await fetch(`${BASE}/api/lists/${list.id}`, {
      method: "DELETE",
      headers: { cookie: `next-auth.session-token=${token}` },
    });
  } finally {
    db.prepare("DELETE FROM list_imports WHERE list_id IN (SELECT id FROM lists WHERE name = 'cookie-kill audit')").run();
    db.prepare("DELETE FROM lists WHERE name = 'cookie-kill audit'").run();
    db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = ? WHERE id = ?").run(
      originalCookies,
      originalAuth,
      account.id
    );
    const restored = db.prepare("SELECT length(cookies_json) AS n, is_authenticated AS a FROM accounts WHERE id = ?").get(account.id) as {
      n: number;
      a: number;
    };
    const authNow = db.prepare("SELECT is_authenticated AS a FROM accounts WHERE id = ?").get(account.id) as { a: number };
    console.log(
      `restored cookie length ${restored.n} (was ${originalCookies.length}) authenticated ${authNow.a} (was ${originalAuth})`
    );
    if (restored.n !== originalCookies.length || authNow.a !== originalAuth) {
      throw new Error("cookie restore mismatch");
    }
    db.close();
  }

  const failed = rows.filter((row) => row.result.startsWith("FAIL") || row.chrome > 0);
  for (const row of rows) {
    console.log(`${row.ms.toString().padStart(6)}ms  chrome+${row.chrome}  ext+${row.external}  ${row.result.padEnd(28)}  ${row.action}`);
  }
  console.log(failed.length === 0 ? "AUDIT PASS" : `AUDIT FAIL ${failed.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
