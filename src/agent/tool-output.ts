import { ToolOutputSchema, formatCredits, type ToolOutput } from "../contracts/tools";

// Model context is presentation, not an accounting API. Never ask the model to
// convert raw units: it repeated them in hosted replies and later history turns.
// Persisted receipts and public numeric contracts retain their original units.
export function modelToolOutput(value: ToolOutput) {
  const { credits, ...output } = ToolOutputSchema.parse(value);
  return { ...output, creditUsage: formatCredits(credits) };
}
