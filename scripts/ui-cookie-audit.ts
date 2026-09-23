import { chromium } from "playwright";
import { encode } from "next-auth/jwt";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const OUT = "/opt/cursor/artifacts";
const BLOCKED = "Blocked before contacting LinkedIn";

async function main() {
  if (!process.env.NEXTAUTH_SECRET) throw new Error("NEXTAUTH_SECRET missing");
  const db = new Database("/workspace/data/linki.db", { readonly: true });
  const user = db.prepare("SELECT id, email FROM users LIMIT 1").get() as { id: string; email: string };
  const list = db.prepare("SELECT id FROM lists WHERE name = 'nbfc reachout'").get() as { id: string };
  db.close();
  const token = await encode({
    token: { sub: user.id, email: user.email },
    secret: process.env.NEXTAUTH_SECRET,
  });

  const browser = await chromium.launch({
    headless: false,
    executablePath: "/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([
    { name: "next-auth.session-token", value: token, url: BASE },
  ]);

  const stayedLocal = () => page.url().startsWith(BASE);

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const sync = page.getByRole("button", { name: "Sync", exact: true });
  await sync.waitFor({ timeout: 15000 });
  await sync.click();
  await page.getByText(BLOCKED).waitFor({ timeout: 10000 });
  if (!stayedLocal()) throw new Error(`left the app: ${page.url()}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/dashboard_sync_blocked_v2.png` });

  await page.goto(`${BASE}/settings?tab=linkedin`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByText("LinkedIn was not contacted").waitFor({ timeout: 10000 });
  if (!stayedLocal()) throw new Error(`left the app: ${page.url()}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/settings_verify_stays_local_v2.png` });

  await page.getByRole("button", { name: "Authenticate" }).click();
  await page.getByText("signs you out of your own browser").waitFor();
  await page.locator("input[type=password]").fill("not-a-real-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByText(BLOCKED).waitFor({ timeout: 10000 });
  if (!stayedLocal()) throw new Error(`left the app: ${page.url()}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/server_login_blocked_v2.png` });
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${BASE}/lists/${list.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Sync Status" }).click();
  await page.getByText("Sync is blocked before LinkedIn is contacted").waitFor();
  await page.locator("select").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Sync Now" }).click();
  await page.getByText(BLOCKED).waitFor({ timeout: 10000 });
  if (!stayedLocal()) throw new Error(`left the app: ${page.url()}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/list_sync_blocked_v2.png` });

  await browser.close();
  console.log("UI audit finished on localhost");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
