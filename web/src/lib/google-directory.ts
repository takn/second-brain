/**
 * Minimal delegated Google Directory client for role resolution: which groups
 * does a user belong to. Uses the same second-brain/gws secret as the worker,
 * fetched at runtime; results cached; every failure degrades to null so the
 * app never blocks on Google (callers default to L2).
 */
import { createSign } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

interface GwsSecret {
  service_account_key: { client_email: string; private_key: string };
  subject: string;
}

const cache = {
  secret: null as GwsSecret | null,
  token: null as { value: string; expiresAt: number } | null,
  groups: new Map<string, { value: string[] | null; expiresAt: number }>(),
};

async function secret(): Promise<GwsSecret | null> {
  if (cache.secret) return cache.secret;
  try {
    if (process.env.GWS_SECRET_JSON) {
      cache.secret = JSON.parse(process.env.GWS_SECRET_JSON) as GwsSecret;
      return cache.secret;
    }
    if (process.env.GWS_SECRET_ID === "") return null;
    const sm = new SecretsManagerClient({ region: process.env.S3_REGION ?? "us-east-1" });
    const res = await sm.send(
      new GetSecretValueCommand({ SecretId: process.env.GWS_SECRET_ID ?? "second-brain/gws" }),
    );
    cache.secret = JSON.parse(res.SecretString ?? "null") as GwsSecret | null;
    return cache.secret;
  } catch {
    return null;
  }
}

async function token(): Promise<string | null> {
  if (cache.token && Date.now() < cache.token.expiresAt - 300_000) return cache.token.value;
  const s = await secret();
  if (!s) return null;
  try {
    const b64url = (v: string) => Buffer.from(v).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: s.service_account_key.client_email,
        sub: s.subject,
        scope: "https://www.googleapis.com/auth/admin.directory.group.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const sig = signer.sign(s.service_account_key.private_key).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${header}.${claims}.${sig}`,
    });
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) return null;
    cache.token = { value: data.access_token, expiresAt: Date.now() + 3_500_000 };
    return cache.token.value;
  } catch {
    return null;
  }
}

/** Group emails the user directly belongs to; null when unavailable. */
export async function groupsForEmail(email: string): Promise<string[] | null> {
  const cached = cache.groups.get(email);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  let value: string[] | null = null;
  const t = await token();
  if (t) {
    try {
      const res = await fetch(
        `https://admin.googleapis.com/admin/directory/v1/groups?userKey=${encodeURIComponent(email)}&maxResults=100`,
        { headers: { Authorization: `Bearer ${t}` } },
      );
      if (res.ok) {
        const data = (await res.json()) as { groups?: { email?: string }[] };
        value = (data.groups ?? []).map((g) => g.email ?? "").filter(Boolean);
      }
    } catch {
      value = null;
    }
  }
  cache.groups.set(email, { value, expiresAt: Date.now() + 600_000 });
  return value;
}
