export async function register() {
  // The worker uses node:sqlite and timers, so it only runs in the Node.js runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/context");
    startWorker();
  }
}
