import { z } from "zod";

export const PLAN_TOOL_NAME = "propose_plan";
export const PLAN_MODE = { label: "Plan mode", description: "Review a plan before the agent starts work.", pending: "Waiting for your plan approval…" } as const;
export const PlanInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(160).describe("A short title describing the requested outcome."),
  steps: z.array(z.string().trim().min(1).max(600)).min(1).max(8).describe("Concrete ordered steps. State what will be done, including media operations and needed user inputs."),
});
export const PlanOutputSchema = z.strictObject({ assets: z.array(z.never()).max(0), credits: z.literal(0), text: z.string().min(1).max(1000), plan: PlanInputSchema });
export const PLAN_APPROVAL_COPY = {
  showEstimate: false, title: "Review plan", estimate: "Plan review", notice: "Approve this plan to continue. Media tasks still require their own settings and credit review.",
  approve: "Approve plan", reject: "Decline plan", expired: "This plan expired. Send a new message to prepare another plan.",
} as const;
