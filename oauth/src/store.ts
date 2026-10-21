// The OAuth bridge's records. The bridge hashes every id and seals every payload (AES-256-GCM) before
// they reach storage, so storage holds no usable value and needs no SQL from the agent: a hosted
// agent's records go to Flow's store behind its own token, a self-hosted agent's to its database.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Database } from "../../src/db.ts";

/** One record as storage sees it: hashed ids, a sealed payload, and when it expires. */
export interface OAuthRecord {
  model: string;
  id: string;
  payload: string;
  /** Milliseconds since the epoch, or null for no expiry. */
  expiresAt: number | null;
  grantId?: string;
  uid?: string;
  userCode?: string;
}

/** Where the bridge keeps its records. Every method acts on one issuer's records only. */
export interface OAuthStorage {
  /** Survives a restart. */
  readonly durable: boolean;
  /** Insert or replace by model and id. */
  set(record: OAuthRecord): Promise<void>;
  /** The payload of an unexpired record found by its id, uid or user code. */
  get(model: string, by: "id" | "uid" | "userCode", value: string): Promise<string | undefined>;
  /** Read and delete in one step, so a one-time value is taken once. Undefined when missing or expired. */
  take(model: string, id: string): Promise<string | undefined>;
  delete(model: string, id: string): Promise<void>;
  /** Delete every record of a grant, and the grant. */
  deleteGrant(grantId: string): Promise<void>;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** OAuthStorage in a Flow Framework Database (SQLite or Postgres), for a self-hosted agent. */
export async function databaseStorage(database: Database, issuer: string): Promise<OAuthStorage> {
  const scope = digest(issuer);
  await database.run(`CREATE TABLE IF NOT EXISTS flow_oauth_artifacts (
    issuer TEXT NOT NULL, model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
    expires_at BIGINT, grant_id TEXT, uid TEXT, user_code TEXT,
    PRIMARY KEY (issuer, model, id))`);
  await database.run("CREATE INDEX IF NOT EXISTS flow_oauth_grants ON flow_oauth_artifacts (issuer, grant_id)");
  const columns = { id: "id", uid: "uid", userCode: "user_code" } as const;
  return {
    durable: database.durable,
    async set(r) {
      await database.run(`INSERT INTO flow_oauth_artifacts (issuer, model, id, payload, expires_at, grant_id, uid, user_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (issuer, model, id) DO UPDATE SET
        payload = excluded.payload, expires_at = excluded.expires_at, grant_id = excluded.grant_id, uid = excluded.uid, user_code = excluded.user_code`,
      [scope, r.model, r.id, r.payload, r.expiresAt, r.grantId ?? null, r.uid ?? null, r.userCode ?? null]);
    },
    async get(model, by, value) {
      const [row] = await database.query(`SELECT payload FROM flow_oauth_artifacts WHERE issuer = ? AND model = ? AND ${columns[by]} = ? AND (expires_at IS NULL OR expires_at > ?)`, [scope, model, value, Date.now()]);
      return row ? String(row.payload) : undefined;
    },
    take: (model, id) => database.transaction(async (tx) => {
      const lock = database.dialect === "postgres" ? " FOR UPDATE" : "";
      const [row] = await tx.query(`SELECT payload, expires_at FROM flow_oauth_artifacts WHERE issuer = ? AND model = ? AND id = ?${lock}`, [scope, model, id]);
      if (!row) return undefined;
      await tx.run("DELETE FROM flow_oauth_artifacts WHERE issuer = ? AND model = ? AND id = ?", [scope, model, id]);
      return row.expires_at !== null && Number(row.expires_at) <= Date.now() ? undefined : String(row.payload);
    }),
    async delete(model, id) { await database.run("DELETE FROM flow_oauth_artifacts WHERE issuer = ? AND model = ? AND id = ?", [scope, model, id]); },
    async deleteGrant(grantId) { await database.run("DELETE FROM flow_oauth_artifacts WHERE issuer = ? AND (grant_id = ? OR (model = 'Grant' AND id = ?))", [scope, grantId, grantId]); },
  };
}

/** oidc-provider's adapters over OAuthStorage, hashing ids and sealing payloads on the way in. */
export function oauthStore(storage: OAuthStorage, issuer: string, encryptionKey: Uint8Array) {
  if (encryptionKey.length !== 32) throw new Error("@flow-engineer/flow/oauth: the encryption key must be 32 bytes");
  const key = Buffer.from(encryptionKey);
  const aad = Buffer.from(digest(issuer));
  const seal = (value: unknown) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  };
  const open = (value: string | undefined): AdapterPayload | undefined => {
    if (value === undefined) return undefined;
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  };
  const write = (model: string, id: string, payload: AdapterPayload, expiresIn?: number) => storage.set({
    model, id: digest(id), payload: seal(payload),
    expiresAt: expiresIn === undefined ? null : Date.now() + expiresIn * 1000,
    ...(payload.grantId ? { grantId: digest(payload.grantId) } : {}),
    ...(payload.uid ? { uid: digest(payload.uid) } : {}),
    ...(payload.userCode ? { userCode: digest(payload.userCode) } : {}),
  });
  const adapter = (model: string): Adapter => ({
    upsert: (id, payload, expiresIn) => write(model, id, payload, expiresIn),
    find: async (id) => open(await storage.get(model, "id", digest(id))),
    findByUid: async (uid) => open(await storage.get(model, "uid", digest(uid))),
    findByUserCode: async (code) => open(await storage.get(model, "userCode", digest(code))),
    async consume(id) {
      const payload = open(await storage.get(model, "id", digest(id)));
      if (!payload) return;
      payload.consumed ??= Math.floor(Date.now() / 1000);
      // The record keeps its expiry: exp is in the payload, in seconds.
      await write(model, id, payload, typeof payload.exp === "number" ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : undefined);
    },
    destroy: (id) => storage.delete(model, digest(id)),
    revokeByGrantId: (grantId) => storage.deleteGrant(digest(grantId)),
  });
  /** A one-time value, read and deleted at once. */
  const take = async (model: string, id: string) => open(await storage.take(model, digest(id)));
  return { adapter, take };
}
