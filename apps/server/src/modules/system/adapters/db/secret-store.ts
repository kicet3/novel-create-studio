import { asc, eq, sql } from "@ncs/db/orm";
import { secrets } from "@ncs/db/schema";
import type { Db, SecretStore } from "../../../../platform/index.js";

/** SecretStore over the `secrets` table (ciphertext only). */
export function createDbSecretStore(db: Db): SecretStore {
  return {
    async read(id) {
      const [r] = await db.select().from(secrets).where(eq(secrets.id, id));
      return r ? { ciphertext: r.ciphertext, nonce: r.nonce, authTag: r.authTag, keyVersion: r.keyVersion, label: r.label } : null;
    },
    async write(id, v, label) {
      await db
        .insert(secrets)
        .values({ id, provider: "local_encrypted", label, ciphertext: v.ciphertext, nonce: v.nonce, authTag: v.authTag, keyVersion: v.keyVersion })
        .onConflictDoUpdate({
          target: secrets.id,
          set: { label, ciphertext: v.ciphertext, nonce: v.nonce, authTag: v.authTag, keyVersion: v.keyVersion, updatedAt: sql`now()` },
        });
    },
    async remove(id) {
      const rows = await db.delete(secrets).where(eq(secrets.id, id)).returning({ id: secrets.id });
      return rows.length > 0;
    },
    async list() {
      return db.select({ id: secrets.id, label: secrets.label, updatedAt: secrets.updatedAt }).from(secrets).orderBy(asc(secrets.id));
    },
  };
}
