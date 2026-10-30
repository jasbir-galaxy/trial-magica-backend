import { ToolResultSchema, type ToolResult } from "../contracts/tools";
import type { ToolRegistry } from "../tools/registry";

export type ExecuteTools = (ids: string[]) => Promise<ToolResult[]>;
export async function dispatchTools(registry: ToolRegistry, invocations: { id: string; name: string }[], media?: ExecuteTools) {
  const groups = new Map<ExecuteTools, string[]>();
  for (const invocation of invocations) {
    const entry = registry.get(invocation.name);
    if (!entry) throw new Error("Tool is not registered.");
    const execute = entry.execute ?? media;
    if (!execute) throw new Error("Tool execution is unavailable.");
    const ids = groups.get(execute) ?? [];
    if (!ids.includes(invocation.id)) ids.push(invocation.id);
    groups.set(execute, ids);
  }
  const outcomes = new Map<string, ToolResult>();
  // A media executor uses Trigger's typed batch API internally. Do not wrap
  // durable Trigger waits in Promise.all; each group retains deterministic order.
  for (const [execute, ids] of groups) {
    const results = await execute(ids);
    if (results.length !== ids.length) throw new Error("Tool batch result count mismatch.");
    for (let i = 0; i < ids.length; i++) outcomes.set(ids[i], ToolResultSchema.parse(results[i]));
  }
  return invocations.map(invocation => outcomes.get(invocation.id)!);
}
