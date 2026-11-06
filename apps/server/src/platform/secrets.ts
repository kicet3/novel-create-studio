/**
 * Secrets (08 §5.4, NFR-SEC-02): `local_encrypted` = AES-256-GCM with a 32-byte master key stored in
 * `<home>/secrets/master.key` (mode 0600, created on first use). Ciphertext rows live in the `secrets`
 * table, owned by the `system` module, which supplies the `SecretStore` implementation.
 * Plaintext never leaves `SecretProvider.get` — do not log it or put it in audit details.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";

export interface EncryptedSecret {
  ciphertext: string; // base64
  nonce: string; // base64 (12 bytes)
  authTag: string; // base64 (16 bytes)
  keyVersion: number;
}

export interface SecretCipher {
  readonly keyVersion: number;
  /** where the master key comes from; `missing` = no key yet (created on the first `encrypt`) */
  keySource(): "env" | "file" | "missing";
  encrypt(plaintext: string, aad: string): EncryptedSecret;
  decrypt(secret: EncryptedSecret, aad: string): string;
}

/**
 * A stored secret cannot be decrypted (CFG-8): the master key is missing or is not the one that
 * encrypted it. Never turned into "not registered" — the user must restore master.key or re-enter.
 */
export class SecretUndecryptableError extends AppError {
  constructor(id: string, reason: "missing_key" | "wrong_key") {
    super(
      409,
      "secret_undecryptable",
      reason === "missing_key"
        ? `저장된 비밀(${id})을 복호화할 수 없습니다: 마스터 키가 없습니다. 원래 기기의 master.key 를 옮기거나 비밀을 다시 입력하세요.`
        : `저장된 비밀(${id})을 복호화할 수 없습니다: 마스터 키가 다릅니다. 원래 master.key 를 옮기거나 비밀을 다시 입력하세요.`,
      { id, reason },
    );
  }
}

function parseKey(raw: string, where: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`master key (${where}) must contain 32 base64-encoded bytes`);
  return key;
}

/**
 * AES-256-GCM cipher (08 §5.4). Key priority: `NCS_SECRETS_MASTER_KEY` (base64, 32 bytes) > key file.
 * A missing key file is NOT regenerated on boot (CFG-8): existing ciphertexts would silently become
 * "unregistered". The key is created on the first `encrypt` (first secret, or a re-entry); decrypting
 * without the key — or with another key — throws SecretUndecryptableError. `aad` binds a ciphertext to its id.
 */
export function createLocalSecretCipher(keyFile: string, opts: { envKey?: string | undefined } = {}): SecretCipher {
  let key: Buffer | null = null;
  let source: "env" | "file" | "missing" = "missing";
  if (opts.envKey?.trim()) {
    key = parseKey(opts.envKey, "NCS_SECRETS_MASTER_KEY");
    source = "env";
  } else if (existsSync(keyFile)) {
    key = parseKey(readFileSync(keyFile, "utf8"), keyFile);
    source = "file";
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* best effort (e.g. Windows) */
    }
  }
  const ensureKey = (): Buffer => {
    if (key) return key;
    if (existsSync(keyFile)) {
      key = parseKey(readFileSync(keyFile, "utf8"), keyFile);
    } else {
      mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
      const k = randomBytes(32);
      writeFileSync(keyFile, k.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      key = k;
    }
    source = "file";
    return key;
  };
  return {
    keyVersion: 1,
    keySource: () => source,
    encrypt(plaintext, aad) {
      const k = ensureKey();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", k, nonce);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext: ct.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), keyVersion: 1 };
    },
    decrypt(secret, aad) {
      if (!key) throw new SecretUndecryptableError(aad, "missing_key");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.nonce, "base64"));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretUndecryptableError(aad, "wrong_key");
      }
    },
  };
}

/** Persistence port for encrypted secrets (implemented by modules/system over the `secrets` table). */
export interface SecretStore {
  read(id: string): Promise<(EncryptedSecret & { label: string | null }) | null>;
  write(id: string, value: EncryptedSecret, label: string | null): Promise<void>;
  remove(id: string): Promise<boolean>;
  list(): Promise<Array<{ id: string; label: string | null; updatedAt: Date }>>;
}

/** SecretProvider port (02 §3.2). Secret ids are free-form keys, e.g. "llm.anthropic.api_key", "telegram.bot.<botId>". */
export interface SecretProvider {
  get(id: string): Promise<string | null>;
  set(id: string, plaintext: string, label?: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** metadata only — never plaintext */
  list(): Promise<Array<{ id: string; label: string | null; updatedAt: Date }>>;
  has(id: string): Promise<boolean>;
}

export function createSecretProvider(cipher: SecretCipher, store: SecretStore): SecretProvider {
  return {
    async get(id) {
      const row = await store.read(id);
      return row ? cipher.decrypt(row, id) : null;
    },
    async set(id, plaintext, label) {
      await store.write(id, cipher.encrypt(plaintext, id), label ?? null);
    },
    delete: (id) => store.remove(id),
    list: () => store.list(),
    async has(id) {
      return (await store.read(id)) !== null;
    },
  };
}

/** In-memory SecretStore (tests, CLI dry runs). */
export function memorySecretStore(): SecretStore {
  const rows = new Map<string, EncryptedSecret & { label: string | null; updatedAt: Date }>();
  return {
    read: async (id) => rows.get(id) ?? null,
    write: async (id, value, label) => void rows.set(id, { ...value, label, updatedAt: new Date() }),
    remove: async (id) => rows.delete(id),
    list: async () => [...rows].map(([id, r]) => ({ id, label: r.label, updatedAt: r.updatedAt })),
  };
}
