import { z } from "zod";

import { FREE_CHAT_MODEL } from "../contracts/runs";
export const FREE_MODEL = FREE_CHAT_MODEL;
const SecretSchema = z.string().min(1).refine((value) => !/\s/.test(value));
const TriggerProjectSchema = z.string().regex(/^proj_[a-zA-Z0-9]+$/);

const OpenRouterEnvironmentSchema = z.object({
  OPENROUTER_API_KEY: SecretSchema,
  // Reject a paid override instead of silently accepting an operator mistake.
  OPENROUTER_MODEL: z.literal(FREE_MODEL).default(FREE_MODEL),
});

const AgentEnvironmentSchema = OpenRouterEnvironmentSchema.extend({
  TRIGGER_SECRET_KEY: SecretSchema,
  TRIGGER_PROJECT_REF: TriggerProjectSchema,
});

export class AgentConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Missing or invalid agent settings: ${fields.join(", ")}.`);
    this.name = "AgentConfigurationError";
  }
}

function parseEnvironment<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Zod issues can contain supplied values. Keep those out of errors and logs.
    throw new AgentConfigurationError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  return result.data;
}

export function readOpenRouterEnvironment(env: Record<string, string | undefined> = process.env) {
  return parseEnvironment(OpenRouterEnvironmentSchema, env);
}

export function readAgentEnvironment(env: Record<string, string | undefined> = process.env) {
  return parseEnvironment(AgentEnvironmentSchema, env);
}
