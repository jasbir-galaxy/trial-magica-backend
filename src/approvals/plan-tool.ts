import "server-only";
import { z } from "zod";
import { getDatabase } from "../db/client";
import { PLAN_TOOL_NAME, PlanInputSchema, PlanOutputSchema } from "../contracts/plans";
import { ToolResultSchema } from "../contracts/tools";
import { hashJson, type ToolRegistry, type RegisteredTool } from "../tools/registry";
import { settleInvocation, toolResult } from "../tools/store";
import { awaitToolApproval, type ApprovalDriver } from "./store";

export async function executePlanTool(id: string, driver: ApprovalDriver, signal: AbortSignal) {
  const db = getDatabase();
  let row = await db.toolInvocation.findUniqueOrThrow({ where: { id }, include: { approval: true } });
  if (row.name !== PLAN_TOOL_NAME) throw new Error("Invalid plan tool.");
  const plan = PlanInputSchema.parse(row.input);
  if (hashJson({ name: row.name, subModelId: undefined, input: row.input }) !== row.inputHash || hashJson(row.inputSchema) !== row.schemaHash) throw new Error("Saved plan changed.");
  if (["pending", "awaiting_approval"].includes(row.status)) {
    signal.throwIfAborted();
    await awaitToolApproval(id, undefined, driver);
    row = await db.toolInvocation.findUniqueOrThrow({ where: { id }, include: { approval: true } });
    signal.throwIfAborted();
    if (row.status === "awaiting_approval" && row.approval?.status === "approved") {
      const output = PlanOutputSchema.parse({ assets: [], credits: 0, text: "The user approved this plan. Continue with its steps. Media settings and credit approvals still apply.", plan });
      return toolResult(await settleInvocation(id, "completed", null, 0, output));
    }
  }
  const result = toolResult(row);
  return !result.ok && row.approval?.status === "rejected" ? ToolResultSchema.parse({ ...result, code: "PLAN_DECLINED" }) : result;
}

export function withPlanTool(full: ToolRegistry, driver: ApprovalDriver, signal: AbortSignal, suspendChecks: <T>(work: () => Promise<T>) => Promise<T>) {
  // Only declared read-only tools are exposed until the recorded plan is approved.
  const registry = new Map([...full].filter(([, tool]) => tool.planSafe));
  let approved = false;
  const execute: NonNullable<RegisteredTool["execute"]> = async ids => {
    const results = [];
    for (const id of ids) {
      const result = await suspendChecks(() => executePlanTool(id, driver, signal));
      results.push(result);
      if (result.ok) {
        approved = true;
        registry.delete(PLAN_TOOL_NAME);
        for (const [name, tool] of full) registry.set(name, tool);
      }
    }
    return results;
  };
  registry.set(PLAN_TOOL_NAME, { name: PLAN_TOOL_NAME, label: "Plan", description: "Present a concrete ordered plan and wait for the user's decision. Call this exactly once before doing the requested work. Do not execute or claim completion before approval. The plan is immutable; the user can decline and send revised instructions.", schema: PlanInputSchema, jsonSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(PlanInputSchema)), execute });
  return { registry, isApproved: () => approved };
}
