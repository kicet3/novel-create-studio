/** drizzle access to the tables owned by `messaging` (channels, messenger_bots, channel_binding_tokens, messenger_inbox, messenger_outbox). */
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "@ncs/db/orm";
import { channelBindingTokens, channels, messengerBots, messengerInbox, messengerOutbox } from "@ncs/db/schema";
import type { ChannelStatus, OutboxStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Channel, MessengerBot, OutboxItem } from "../../index.js";

export type InboxRow = typeof messengerInbox.$inferSelect;
export type BindingTokenRow = typeof channelBindingTokens.$inferSelect;

export const messagingRepo = {
  // ── bots ──
  async insertBot(db: Db, row: typeof messengerBots.$inferInsert): Promise<MessengerBot> {
    const [b] = await db.insert(messengerBots).values(row).returning();
    return b!;
  },
  listBots: (db: Db) => db.select().from(messengerBots).orderBy(asc(messengerBots.createdAt)),
  async getBot(db: Db, botId: string): Promise<MessengerBot | null> {
    const [b] = await db.select().from(messengerBots).where(eq(messengerBots.id, botId));
    return b ?? null;
  },
  listPollingBots: (db: Db) =>
    db
      .select()
      .from(messengerBots)
      .where(and(eq(messengerBots.kind, "telegram"), eq(messengerBots.receiveMode, "polling"), inArray(messengerBots.status, ["active", "degraded"]))),
  async updateBot(db: Db, botId: string, patch: Partial<typeof messengerBots.$inferInsert>): Promise<MessengerBot | null> {
    const [b] = await db.update(messengerBots).set(patch).where(eq(messengerBots.id, botId)).returning();
    return b ?? null;
  },

  // ── channels ──
  listChannels: (db: Db, scope: NovelScope) =>
    db.select().from(channels).where(eq(channels.novelId, scope.novelId)).orderBy(asc(channels.createdAt)),
  async getChannel(db: Db, scope: NovelScope, channelId: string, forUpdate = false): Promise<Channel | null> {
    const q = db.select().from(channels).where(and(eq(channels.novelId, scope.novelId), eq(channels.id, channelId)));
    const [c] = forUpdate ? await q.for("update") : await q;
    return c ?? null;
  },
  /** install-level lookup by id (inbox resolution only) */
  async getChannelById(db: Db, channelId: string): Promise<Channel | null> {
    const [c] = await db.select().from(channels).where(eq(channels.id, channelId));
    return c ?? null;
  },
  /** I3: bound chats of a bot (any novel), newest binding first */
  findChannelsForChat: (db: Db, botId: string, chatRef: string) =>
    db
      .select()
      .from(channels)
      .where(and(eq(channels.botId, botId), ne(channels.status, "revoked"), sql`${channels.externalChatRef}->>'chatId' = ${chatRef}`))
      .orderBy(desc(channels.boundAt)),
  listChannelsOfBot: (db: Db, botId: string) => db.select().from(channels).where(and(eq(channels.botId, botId), ne(channels.status, "revoked"))),
  async insertChannel(db: Db, row: typeof channels.$inferInsert): Promise<Channel> {
    const [c] = await db.insert(channels).values(row).returning();
    return c!;
  },
  async updateChannel(db: Db, scope: NovelScope, channelId: string, patch: Partial<typeof channels.$inferInsert>, fromStatuses?: ChannelStatus[]): Promise<Channel | null> {
    const conds = [eq(channels.novelId, scope.novelId), eq(channels.id, channelId)];
    if (fromStatuses) conds.push(inArray(channels.status, fromStatuses));
    const [c] = await db.update(channels).set(patch).where(and(...conds)).returning();
    return c ?? null;
  },

  // ── binding tokens ──
  async insertToken(db: Db, row: typeof channelBindingTokens.$inferInsert): Promise<BindingTokenRow> {
    const [t] = await db.insert(channelBindingTokens).values(row).returning();
    return t!;
  },
  revokeIssuedTokens: (db: Db, scope: NovelScope, botId: string, at: Date) =>
    db
      .update(channelBindingTokens)
      .set({ status: "revoked", updatedAt: at })
      .where(and(eq(channelBindingTokens.novelId, scope.novelId), eq(channelBindingTokens.botId, botId), eq(channelBindingTokens.status, "issued")))
      .returning({ id: channelBindingTokens.id }),
  async findTokenByHash(db: Db, hash: string): Promise<BindingTokenRow | null> {
    const [t] = await db.select().from(channelBindingTokens).where(eq(channelBindingTokens.tokenHash, hash)).for("update");
    return t ?? null;
  },
  async updateToken(db: Db, id: string, patch: Partial<typeof channelBindingTokens.$inferInsert>): Promise<void> {
    await db.update(channelBindingTokens).set(patch).where(eq(channelBindingTokens.id, id));
  },
  expireTokens: (db: Db, now: Date) =>
    db
      .update(channelBindingTokens)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(channelBindingTokens.status, "issued"), lte(channelBindingTokens.expiresAt, now)))
      .returning({ id: channelBindingTokens.id }),

  // ── inbox ──
  /** I1: INSERT … ON CONFLICT (dedupe_key) DO NOTHING; null = already recorded */
  async insertInbox(db: Db, row: typeof messengerInbox.$inferInsert): Promise<InboxRow | null> {
    const [r] = await db.insert(messengerInbox).values(row).onConflictDoNothing({ target: messengerInbox.dedupeKey }).returning();
    return r ?? null;
  },
  /** IN2: claim due rows (received/retry) with SKIP LOCKED */
  async claimInbox(db: Db, now: Date, limit: number): Promise<InboxRow[]> {
    const due = db
      .select({ id: messengerInbox.id })
      .from(messengerInbox)
      .where(and(inArray(messengerInbox.status, ["received", "retry"]), or(isNull(messengerInbox.nextAttemptAt), lte(messengerInbox.nextAttemptAt, now))))
      .orderBy(asc(messengerInbox.receivedAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    return db.update(messengerInbox).set({ status: "processing", updatedAt: now }).where(inArray(messengerInbox.id, due)).returning();
  },
  async getInbox(db: Db, id: string): Promise<InboxRow | null> {
    const [r] = await db.select().from(messengerInbox).where(eq(messengerInbox.id, id));
    return r ?? null;
  },
  async updateInbox(db: Db, id: string, patch: Partial<typeof messengerInbox.$inferInsert>): Promise<void> {
    await db.update(messengerInbox).set(patch).where(and(eq(messengerInbox.id, id), eq(messengerInbox.status, "processing")));
  },
  /** IN7: processing rows older than `before` → retry (attempt_count unchanged) */
  recoverStaleInbox: (db: Db, before: Date, now: Date) =>
    db
      .update(messengerInbox)
      .set({ status: "retry", nextAttemptAt: now, updatedAt: now })
      .where(and(eq(messengerInbox.status, "processing"), lte(messengerInbox.updatedAt, before)))
      .returning({ id: messengerInbox.id }),

  // ── outbox ──
  /** idempotent enqueue (idempotency_key unique) — returns the existing row on conflict */
  async insertOutbox(db: Db, row: typeof messengerOutbox.$inferInsert): Promise<{ row: OutboxItem; created: boolean }> {
    const [r] = await db.insert(messengerOutbox).values(row).onConflictDoNothing({ target: messengerOutbox.idempotencyKey }).returning();
    if (r) return { row: r, created: true };
    const [e] = await db.select().from(messengerOutbox).where(eq(messengerOutbox.idempotencyKey, row.idempotencyKey));
    return { row: e!, created: false };
  },
  async claimOutbox(db: Db, now: Date, limit: number): Promise<OutboxItem[]> {
    const due = db
      .select({ id: messengerOutbox.id })
      .from(messengerOutbox)
      .where(and(inArray(messengerOutbox.status, ["pending", "retry"]), or(isNull(messengerOutbox.nextAttemptAt), lte(messengerOutbox.nextAttemptAt, now))))
      .orderBy(asc(messengerOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    return db.update(messengerOutbox).set({ status: "sending", updatedAt: now }).where(inArray(messengerOutbox.id, due)).returning();
  },
  async updateOutbox(db: Db, id: string, from: OutboxStatus[], patch: Partial<typeof messengerOutbox.$inferInsert>): Promise<OutboxItem | null> {
    const [r] = await db.update(messengerOutbox).set(patch).where(and(eq(messengerOutbox.id, id), inArray(messengerOutbox.status, from))).returning();
    return r ?? null;
  },
  recoverStaleOutbox: (db: Db, before: Date, now: Date) =>
    db
      .update(messengerOutbox)
      .set({ status: "delivery_unknown", updatedAt: now, lastError: "process stopped while sending" })
      .where(and(eq(messengerOutbox.status, "sending"), lte(messengerOutbox.updatedAt, before)))
      .returning(),
  /** the message that delivered `questionId` on `channelId` (question row, or a digest containing it), newest first */
  async findQuestionMessage(db: Db, scope: NovelScope, channelId: string, questionId: string): Promise<OutboxItem | null> {
    const [r] = await db
      .select()
      .from(messengerOutbox)
      .where(
        and(
          eq(messengerOutbox.novelId, scope.novelId),
          eq(messengerOutbox.channelId, channelId),
          or(
            and(eq(messengerOutbox.kind, "question"), eq(messengerOutbox.questionId, questionId)),
            and(eq(messengerOutbox.kind, "digest"), sql`${messengerOutbox.payload}->'questionIds' ? ${questionId}`),
          ),
        ),
      )
      .orderBy(desc(messengerOutbox.createdAt))
      .limit(1);
    return r ?? null;
  },
  async findByProviderRef(db: Db, channelId: string, providerMessageRef: string): Promise<OutboxItem | null> {
    const [r] = await db
      .select()
      .from(messengerOutbox)
      .where(and(eq(messengerOutbox.channelId, channelId), eq(messengerOutbox.providerMessageRef, providerMessageRef)))
      .limit(1);
    return r ?? null;
  },
  /** OB7 for every unsent row of a channel (optionally only one question's rows) */
  cancelUnsent: (db: Db, scope: NovelScope, channelId: string, now: Date, questionId?: string) =>
    db
      .update(messengerOutbox)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(messengerOutbox.novelId, scope.novelId),
          eq(messengerOutbox.channelId, channelId),
          inArray(messengerOutbox.status, ["pending", "retry"]),
          ...(questionId ? [eq(messengerOutbox.questionId, questionId)] : []),
        ),
      )
      .returning(),
  async countOutbox(db: Db, scope: NovelScope, idempotencyPrefix: string): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messengerOutbox)
      .where(and(eq(messengerOutbox.novelId, scope.novelId), sql`${messengerOutbox.idempotencyKey} LIKE ${idempotencyPrefix + "%"}`));
    return r?.n ?? 0;
  },
};
