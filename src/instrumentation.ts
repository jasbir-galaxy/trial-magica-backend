export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getSkillRegistry } = await import("./skills/registry");
    await getSkillRegistry();
  }
}
