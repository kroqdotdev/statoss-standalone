export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { basePathMismatch } = await import("./lib/base-path");
    const mismatch = basePathMismatch(process.env.BASE_PATH);
    if (mismatch) console.warn(mismatch);
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
