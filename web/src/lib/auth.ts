/**
 * Identity and roles (task 5.1). The oauth2-proxy gate is the sole IdP: it
 * verifies the Google session and forwards the user as X-Forwarded-Email —
 * the app never runs its own OIDC flow. The Next server binds to loopback
 * behind the proxy, so the header is trustworthy inside the container.
 *
 * Roles: L1 (leadership — global reject rights, portfolio view) vs L2 (POCs).
 * Resolution order: L1_EMAILS env override → Google Group membership via the
 * directory service account → ROLE_DEFAULT (dev-phase: L1 for everyone until
 * the second-brain-l1/-l2 Google groups exist; production default is L2).
 */
import { headers } from "next/headers";
import { groupsForEmail } from "./google-directory";

export type Role = "L1" | "L2";

export interface User {
  email: string;
  role: Role;
}

/** Google Group granting L1; empty disables the lookup (everyone gets ROLE_DEFAULT). */
const L1_GROUP = process.env.L1_GROUP_EMAIL ?? "";

async function resolveRole(email: string): Promise<Role> {
  const overrides = (process.env.L1_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (overrides.includes(email.toLowerCase())) return "L1";

  // Google Groups lookup, memoized + fail-open to the default (groups may not exist yet).
  if (L1_GROUP) {
    const groups = await groupsForEmail(email);
    if (groups?.some((g) => g.toLowerCase() === L1_GROUP.toLowerCase())) return "L1";
  }
  return process.env.ROLE_DEFAULT === "L1" ? "L1" : "L2";
}

export async function getUser(): Promise<User> {
  const h = await headers();
  const email =
    h.get("x-forwarded-email") ??
    (process.env.NODE_ENV !== "production" ? (process.env.DEV_USER_EMAIL ?? "dev@local") : null);
  if (!email) {
    // Behind the fail-closed gate this cannot happen; direct container access
    // is prevented by the loopback bind. Belt and braces:
    throw new Error("no authenticated identity on request");
  }
  return { email, role: await resolveRole(email) };
}
