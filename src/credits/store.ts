import "server-only";
import { z } from "zod";
import { getDatabase } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { CREDIT_ADMISSION_AMOUNT, CreditsSchema, CreditHistorySchema } from "../contracts/credits";
import { HttpError } from "../http/errors";
import { decodeCursor, makePage } from "../chats/pagination";
import type { PageQuery } from "../contracts/chats";
import { formatCredits } from "../contracts/tools";
export type Transaction = Prisma.TransactionClient;
const amountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export function initialCredits() { return z.coerce.number().int().min(0).max(1_000_000_000).parse(process.env.TRIAL_INITIAL_CREDITS ?? "0"); }
export async function ensureAccount(tx: Transaction, userId: string) {
  const grant = initialCredits();
  const created = await tx.creditAccount.createMany({ data: [{ userId, balance: grant }], skipDuplicates: true });
  if (created.count) await tx.creditLedger.create({ data: { key: `grant:${userId}`, userId, kind: "grant", balanceDelta: grant, reservedDelta: 0 } });
  await tx.$queryRaw`SELECT "userId" FROM "CreditAccount" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
  return tx.creditAccount.findUniqueOrThrow({ where: { userId } });
}
// Callers lock domain rows in order: AgentRun -> ToolInvocation -> CreditAccount.
// Account locks are short and per user; no provider/Trigger calls occur inside them.
export async function reserve(tx: Transaction, userId: string, runId: string, key: string, amount: number, toolId?: string) {
  amountSchema.parse(amount);
  const account = await ensureAccount(tx, userId);
  const prior = await tx.creditReservation.findUnique({ where: { key } });
  if (prior) {
    if (prior.userId !== userId || prior.runId !== runId || prior.toolId !== (toolId ?? null) || prior.amount !== BigInt(amount)) throw new Error("Reservation identity mismatch");
    return prior;
  }
  if (account.balance - account.reserved < BigInt(amount)) throw new HttpError(402, "INSUFFICIENT_CREDITS", `There are not enough available credits. This task needs an estimated ${formatCredits(amount)}.`);
  const receipt = await tx.creditReservation.create({ data: { key, userId, runId, toolId, amount } });
  await tx.creditAccount.update({ where: { userId }, data: { reserved: { increment: amount } } });
  await tx.creditLedger.create({ data: { key: `reserve:${receipt.id}`, userId, reservationId: receipt.id, kind: "reserve", balanceDelta: 0, reservedDelta: amount } });
  return receipt;
}
export async function settleReservation(tx: Transaction, key: string, actual: number) {
  amountSchema.parse(actual);
  const receipt = await tx.creditReservation.findUnique({ where: { key } });
  if (!receipt) return; // Historical runs predating credit admission are not charged retroactively.
  await ensureAccount(tx, receipt.userId);
  const current = await tx.creditReservation.findUniqueOrThrow({ where: { id: receipt.id } });
  if (current.settledAt) return;
  // A reservation is not a cap. Record incurred usage above or below the estimate,
  // even if it produces a debt; subsequent admission blocks until funding exists.
  await tx.creditAccount.update({ where: { userId: current.userId }, data: { balance: { decrement: actual }, reserved: { decrement: current.amount } } });
  await tx.creditReservation.update({ where: { id: current.id }, data: { actualAmount: actual, settledAt: new Date() } });
  await tx.creditLedger.create({ data: { key: `settle:${current.id}`, userId: current.userId, reservationId: current.id, kind: "settle", balanceDelta: -actual, reservedDelta: -current.amount } });
}
function creditsDto(account: { balance: bigint; reserved: bigint }) {
  return CreditsSchema.parse({ balance: Number(account.balance), reserved: Number(account.reserved), available: Number(account.balance > account.reserved ? account.balance - account.reserved : BigInt(0)), admissionAmount: CREDIT_ADMISSION_AMOUNT });
}
export async function accountForUser(clerkUserId: string) {
  const existing = await getDatabase().creditAccount.findFirst({ where: { user: { clerkUserId } } });
  if (existing) return creditsDto(existing);
  return getDatabase().$transaction(async tx => {
    await tx.user.createMany({ data: [{ clerkUserId }], skipDuplicates: true });
    const user = await tx.user.findUniqueOrThrow({ where: { clerkUserId } });
    const account = await ensureAccount(tx, user.id);
    return creditsDto(account);
  });
}
export async function creditHistory(clerkUserId: string, query: PageQuery) {
  const boundary = decodeCursor(query.cursor, "credit-ledger");
  const rows = await getDatabase().creditLedger.findMany({ where: { account: { user: { clerkUserId } }, ...(boundary ? { OR: [{ createdAt: { lt: boundary.createdAt } }, { createdAt: boundary.createdAt, id: { lt: boundary.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 });
  const page = makePage(rows, query.limit, "credit-ledger");
  return CreditHistorySchema.parse({ ...page, items: page.items.map(row => ({ ...row, balanceDelta: Number(row.balanceDelta), reservedDelta: Number(row.reservedDelta), createdAt: row.createdAt.toISOString() })) });
}
