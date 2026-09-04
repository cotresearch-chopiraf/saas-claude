import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notifications } from "../db/schema.js";

// Slice AA Scope F — minimal notification domain module. Every function
// takes companyId AND recipientUserId explicitly and filters by both — the
// ownership boundary is enforced here, once, rather than trusted to each
// caller to remember. No producer calls createNotification yet (see the
// schema's own comment); this module exists so a future producer and this
// slice's read/mark-read API share exactly one implementation.

export interface CreateNotificationInput {
  companyId: string;
  recipientUserId: string;
  type: string;
  title: string;
  message: string;
  referenceEntityType?: string;
  referenceEntityId?: string;
}

export interface DbLike {
  insert: typeof db.insert;
}

export async function createNotification(dbOrTx: DbLike, input: CreateNotificationInput) {
  const [created] = await dbOrTx
    .insert(notifications)
    .values({
      companyId: input.companyId,
      recipientUserId: input.recipientUserId,
      type: input.type,
      title: input.title,
      message: input.message,
      referenceEntityType: input.referenceEntityType,
      referenceEntityId: input.referenceEntityId,
    })
    .returning();
  return created;
}

export async function listNotifications(
  companyId: string,
  recipientUserId: string,
  { limit, offset }: { limit: number; offset: number },
) {
  return db.query.notifications.findMany({
    where: and(eq(notifications.companyId, companyId), eq(notifications.recipientUserId, recipientUserId)),
    orderBy: (n, { desc }) => [desc(n.createdAt)],
    limit,
    offset,
  });
}

export async function countUnread(companyId: string, recipientUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.recipientUserId, recipientUserId),
        isNull(notifications.readAt),
      ),
    );
  return row?.count ?? 0;
}

// Ownership-checked: only updates a row that belongs to BOTH the caller's
// company and the caller themself — a notification id from another user or
// another company simply matches zero rows (returns null), never a 500 or
// a cross-tenant leak of whether the id exists.
export async function markRead(companyId: string, recipientUserId: string, notificationId: string) {
  const [updated] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.companyId, companyId),
        eq(notifications.recipientUserId, recipientUserId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function markAllRead(companyId: string, recipientUserId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.recipientUserId, recipientUserId),
        isNull(notifications.readAt),
      ),
    );
}
