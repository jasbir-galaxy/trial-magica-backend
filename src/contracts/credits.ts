import { z } from "zod";
import { PLAN_APPROVAL_COPY } from "./plans";
export const CREDIT_ADMISSION_AMOUNT = 1000;
export const APPROVAL_TIMEOUT_SECONDS = 10 * 60;
export const CreditsSchema = z.object({ balance: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), reserved: z.number().int().nonnegative(), available: z.number().int().nonnegative(), admissionAmount: z.number().int().nonnegative() });
export const CreditEntrySchema = z.object({ id: z.uuid(), kind: z.enum(["grant", "reserve", "settle"]), balanceDelta: z.number().int(), reservedDelta: z.number().int(), createdAt: z.iso.datetime() });
export const CreditHistorySchema = z.object({ items: z.array(CreditEntrySchema).max(100), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const ApprovalSchema = z.object({ kind: z.enum(["media", "plan"]).optional(), id: z.uuid(), status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]), inputHash: z.string().regex(/^[a-f0-9]{64}$/), estimate: z.number().int().nonnegative(), expiresAt: z.iso.datetime() });
export const ApprovalDecisionSchema = z.strictObject({ requestId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approved", "rejected"]) });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export const APPROVAL_COPY = { showEstimate: true, title: "Review media task", estimate: "Estimated usage", notice: "Review the settings below before continuing. This estimate reserves credits; final usage may be higher or lower.", approve: "Approve and run", reject: "Decline", expired: "This approval expired. Send a new message to continue." } as const;

export const APPROVAL_COPY_BY_KIND = { media: APPROVAL_COPY, plan: PLAN_APPROVAL_COPY } as const;
