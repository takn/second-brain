/**
 * Google Workspace connector (task 3.7): directory → person entities,
 * Calendar events and watched-folder transcripts → raw artifacts, with
 * transcripts normalized to the standard schema.
 *
 * Auth: domain-wide delegation. The worker holds the service-account key
 * (from the second-brain/gws secret, fetched at runtime) and mints short-lived
 * delegated tokens as the ingestion subject. Collection scope is fail-closed
 * (ingestion-pipeline spec): the subject sees only what is shared with it,
 * impersonation is fixed to the configured subject, and GWS_DENYLIST skips
 * visible-but-excluded ids at collect time.
 */
import { createSign } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { and, eq, isNull } from "drizzle-orm";
import { tables, type Job } from "@second-brain/schema";
import type { WorkerDeps } from "../lib/deps.ts";
import { putRawArtifact, type RawEnvelope } from "../raw.ts";
import { normalizeTranscript } from "./transcripts.ts";

export interface GwsConfig {
  serviceAccountKey: { client_email: string; private_key: string };
  subject: string;
  watchedFolderId: string;
  domain: string;
  denylist: Set<string>;
}

let cachedConfig: Promise<GwsConfig | null> | null = null;

/** Memoized config load — the secret fetch happens once per process. */
export function getGwsConfig(): Promise<GwsConfig | null> {
  cachedConfig ??= loadGwsConfig();
  return cachedConfig;
}

export async function loadGwsConfig(env = process.env): Promise<GwsConfig | null> {
  let secretJson = env.GWS_SECRET_JSON;
  if (!secretJson && env.GWS_SECRET_ID !== "") {
    try {
      const sm = new SecretsManagerClient({ region: env.S3_REGION ?? "us-east-1" });
      const res = await sm.send(
        new GetSecretValueCommand({ SecretId: env.GWS_SECRET_ID ?? "second-brain/gws" }),
      );
      secretJson = res.SecretString;
    } catch {
      return null;
    }
  }
  if (!secretJson) return null;
  const parsed = JSON.parse(secretJson) as {
    service_account_key: { client_email: string; private_key: string };
    subject: string;
    watched_folder_id: string;
  };
  return {
    serviceAccountKey: parsed.service_account_key,
    subject: parsed.subject,
    watchedFolderId: parsed.watched_folder_id,
    // Required for directory/people sync; connectors fail closed when unset.
    domain: env.GWS_DOMAIN ?? "",
    denylist: new Set((env.GWS_DENYLIST ?? "").split(",").filter(Boolean)),
  };
}

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
].join(" ");

export type GwsCall = (url: string, accept?: "json" | "text") => Promise<unknown>;

/** Delegated-token client with caching; injectable fetch for tests. */
export function createGwsClient(config: GwsConfig, fetchImpl = fetch): GwsCall {
  let token: { value: string; expiresAt: number } | null = null;

  async function mintToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 300_000) return token.value;
    const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: config.serviceAccountKey.client_email,
        sub: config.subject,
        scope: SCOPES,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(config.serviceAccountKey.private_key).toString("base64url");

    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${header}.${claims}.${signature}`,
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !data.access_token) throw new Error(`gws token mint failed: ${data.error}`);
    token = { value: data.access_token, expiresAt: Date.now() + 3_500_000 };
    return token.value;
  }

  return async function call(url, accept = "json") {
    const t = await mintToken();
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${t}` } });
    if (!res.ok) throw new Error(`gws GET ${url.split("?")[0]}: HTTP ${res.status}`);
    return accept === "json" ? res.json() : res.text();
  };
}

const CURSOR_KEY = "gws:sync-cursor";

interface GwsCursor {
  driveSince?: string;
  calendarSince?: string;
  directoryDay?: string;
}

async function getCursor(deps: WorkerDeps): Promise<GwsCursor> {
  const [row] = await deps.db
    .select()
    .from(tables.connectorState)
    .where(eq(tables.connectorState.key, CURSOR_KEY));
  return (row?.value as GwsCursor | undefined) ?? {};
}

async function setCursor(deps: WorkerDeps, cursor: GwsCursor): Promise<void> {
  await deps.db
    .insert(tables.connectorState)
    .values({ key: CURSOR_KEY, value: cursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: tables.connectorState.key,
      set: { value: cursor, updatedAt: new Date() },
    });
}

const enqueueNormalize = (deps: WorkerDeps, sourceKey: string) =>
  deps.enqueue([
    {
      kind: "normalize",
      source: "gws",
      sourceKey,
      payload: {},
      enqueuedAt: new Date().toISOString(),
    } satisfies Job,
  ]);

export async function syncGws(
  deps: WorkerDeps,
  call: GwsCall,
  config: GwsConfig,
  now = new Date(),
): Promise<{ artifacts: number; people: number }> {
  const cursor = await getCursor(deps);
  let artifacts = 0;

  // --- Directory: one snapshot artifact per day; normalize upserts people. ---
  const today = now.toISOString().slice(0, 10);
  let people = 0;
  if (cursor.directoryDay !== today) {
    const users: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    do {
      // domain_public view: readable by a non-admin subject (the default
      // admin view 403s unless the subject holds a Users-Read admin role).
      const page = (await call(
        `https://admin.googleapis.com/admin/directory/v1/users?domain=${config.domain}&maxResults=200&projection=basic&viewType=domain_public${pageToken ? `&pageToken=${pageToken}` : ""}`,
      )) as { users?: Record<string, unknown>[]; nextPageToken?: string };
      users.push(...(page.users ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    const kept = users.filter(
      (u) => !config.denylist.has(u.primaryEmail as string) && !(u.suspended as boolean),
    );
    const sourceKey = `gws:directory:${today}`;
    const { created } = await putRawArtifact(deps, {
      source: "gws",
      sourceKey,
      payload: {
        surface: "directory",
        users: kept.map((u) => ({
          id: u.id,
          primaryEmail: u.primaryEmail,
          name: (u.name as { fullName?: string })?.fullName,
          orgUnitPath: u.orgUnitPath,
        })),
      },
      sourceMeta: { timestamps: { snapshotAt: now.toISOString() } },
    });
    if (created) {
      artifacts++;
      people = kept.length;
      await enqueueNormalize(deps, sourceKey);
    }
    cursor.directoryDay = today;
  }

  // --- Calendar: subject's calendar, updated-since cursor. ---
  const calSince = cursor.calendarSince ?? now.toISOString();
  let calPageToken: string | undefined;
  let maxCalUpdated = calSince;
  do {
    const page = (await call(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?updatedMin=${encodeURIComponent(calSince)}&maxResults=100&singleEvents=false&showDeleted=false${calPageToken ? `&pageToken=${calPageToken}` : ""}`,
    )) as { items?: Record<string, unknown>[]; nextPageToken?: string };
    for (const ev of page.items ?? []) {
      if (config.denylist.has(ev.id as string)) continue;
      const updated = (ev.updated as string) ?? now.toISOString();
      const sourceKey = `gws:cal:${ev.id}:${updated}`;
      const { created } = await putRawArtifact(deps, {
        source: "gws",
        sourceKey,
        payload: { surface: "calendar", event: ev },
        sourceMeta: {
          permalink: ev.htmlLink as string,
          author: (ev.organizer as { email?: string })?.email,
          timestamps: { updatedAt: updated },
        },
      });
      if (created) {
        artifacts++;
        await enqueueNormalize(deps, sourceKey);
      }
      if (updated > maxCalUpdated) maxCalUpdated = updated;
    }
    calPageToken = page.nextPageToken;
  } while (calPageToken);
  cursor.calendarSince = maxCalUpdated;

  // --- Watched shared drive: transcript files modified since cursor. ---
  const driveSince = cursor.driveSince ?? now.toISOString();
  let drivePageToken: string | undefined;
  let maxModified = driveSince;
  do {
    const q = encodeURIComponent(`modifiedTime > '${driveSince}' and trashed = false`);
    const page = (await call(
      `https://www.googleapis.com/drive/v3/files?q=${q}&corpora=drive&driveId=${config.watchedFolderId}&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners)")}&pageSize=100${drivePageToken ? `&pageToken=${drivePageToken}` : ""}`,
    )) as { files?: Record<string, unknown>[]; nextPageToken?: string };

    for (const f of page.files ?? []) {
      const modified = f.modifiedTime as string;
      if (modified > maxModified) maxModified = modified;
      if (config.denylist.has(f.id as string)) continue;

      const mime = f.mimeType as string;
      if (mime === "application/vnd.google-apps.folder") continue;
      // Text-bearing files only; recordings stay raw-uncollected (deferred).
      let content: string | null = null;
      if (mime === "application/vnd.google-apps.document") {
        content = (await call(
          `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`,
          "text",
        )) as string;
      } else if (mime.startsWith("text/") || (f.name as string).match(/\.(vtt|txt|srt)$/i)) {
        content = (await call(
          `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`,
          "text",
        )) as string;
      } else {
        deps.logger.info({ file: f.name, mime }, "watched-drive file is not text; stored later via transcription work");
        continue;
      }

      const sourceKey = `gws:drive:${f.id}:${modified}`;
      const { created } = await putRawArtifact(deps, {
        source: "gws",
        sourceKey,
        payload: { surface: "drive", fileName: f.name, mimeType: mime, content },
        sourceMeta: {
          permalink: f.webViewLink as string,
          author: ((f.owners as { emailAddress?: string }[] | undefined) ?? [])[0]?.emailAddress,
          timestamps: { modifiedAt: modified },
        },
      });
      if (created) {
        artifacts++;
        await enqueueNormalize(deps, sourceKey);
      }
    }
    drivePageToken = page.nextPageToken;
  } while (drivePageToken);
  cursor.driveSince = maxModified;

  await setCursor(deps, cursor);
  return { artifacts, people };
}

/** normalize-stage mapping for gws artifacts. */
export async function mapGwsArtifact(
  deps: WorkerDeps,
  artifactRow: { id: string; objectKey: string },
  envelope: RawEnvelope,
): Promise<void> {
  const payload = envelope.payload as Record<string, unknown>;

  if (payload.surface === "directory") {
    const users = payload.users as {
      primaryEmail: string;
      name?: string;
      id?: string;
    }[];
    for (const u of users) {
      const [byEmail] = await deps.db
        .select({ id: tables.people.id })
        .from(tables.people)
        .where(eq(tables.people.email, u.primaryEmail));
      if (byEmail) {
        await deps.db
          .update(tables.people)
          .set({ displayName: u.name ?? u.primaryEmail, updatedAt: new Date() })
          .where(eq(tables.people.id, byEmail.id));
        continue;
      }
      // Merge with a GitLab-seeded row (same display name, no email yet).
      const [byName] = await deps.db
        .select({ id: tables.people.id })
        .from(tables.people)
        .where(and(eq(tables.people.displayName, u.name ?? ""), isNull(tables.people.email)));
      if (byName) {
        await deps.db
          .update(tables.people)
          .set({ email: u.primaryEmail, updatedAt: new Date() })
          .where(eq(tables.people.id, byName.id));
      } else {
        await deps.db
          .insert(tables.people)
          .values({ displayName: u.name ?? u.primaryEmail, email: u.primaryEmail })
          .onConflictDoNothing({ target: tables.people.email });
      }
    }
    return;
  }

  if (payload.surface === "drive") {
    const transcript = normalizeTranscript(
      (payload.content as string) ?? "",
      (payload.fileName as string) ?? "",
    );
    if (transcript) {
      const normalizedKey = artifactRow.objectKey.replace(/^raw\//, "normalized/");
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await deps.s3.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: normalizedKey,
          ContentType: "application/json",
          Body: JSON.stringify(transcript),
        }),
      );
      await deps.db
        .update(tables.rawArtifacts)
        .set({ normalizedObjectKey: normalizedKey })
        .where(eq(tables.rawArtifacts.id, artifactRow.id));
      deps.logger.info(
        {
          sourceKey: envelope.sourceKey,
          origin: transcript.origin,
          segments: transcript.segments.length,
          uncertain: transcript.segments.filter((s) => !s.attributionConfirmed).length,
        },
        "transcript normalized",
      );
      // Meeting transcripts are signal by definition — straight to the
      // Extractor (design D2), no triage stage.
      await deps.enqueue([
        {
          kind: "extract",
          source: "gws",
          sourceKey: envelope.sourceKey,
          payload: {},
          enqueuedAt: new Date().toISOString(),
        },
      ]);
    }
    return; // non-transcript drive docs stay raw; the design-gap check reads them directly
  }

  // calendar (and future surfaces): collected raw, mapped when 4.2 lands
}
