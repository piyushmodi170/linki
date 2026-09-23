// Saved LinkedIn cookies presented from this server — headless Chrome or a
// plain HTTP client — get revoked. That signs the person out of the browser
// they copied the cookies from. Every path that would contact LinkedIn with
// those cookies, or sign in from here, goes through this guard first.
//
// Set LINKEDIN_REMOTE=1 only when that sign-out is acceptable.

export const LINKEDIN_REMOTE_BLOCKED_MESSAGE =
  "Blocked before contacting LinkedIn. Sending saved cookies from this server revokes the session and signs you out of the browser you copied them from. Nothing was sent.";

export function linkedInRemoteAllowed(): boolean {
  return process.env.LINKEDIN_REMOTE === "1";
}

export function isLinkedInRemoteBlocked(err: unknown): boolean {
  return err instanceof Error && err.name === "LinkedInRemoteBlocked";
}

export function assertLinkedInRemoteAllowed(): void {
  if (linkedInRemoteAllowed()) return;
  const err = new Error(LINKEDIN_REMOTE_BLOCKED_MESSAGE);
  err.name = "LinkedInRemoteBlocked";
  throw err;
}
