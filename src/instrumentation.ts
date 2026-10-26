export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { ensureGenerationWorker } = await import("./modules/authoring/generation/service");
    ensureGenerationWorker();
    const { ensureSkillOutlineWorker } = await import("./modules/blueprints/skill-outline-generation");
    ensureSkillOutlineWorker();
  }
}
