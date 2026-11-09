export async function register() {
  // The worker uses the database drivers (node:sqlite, pg) and timers, so it only runs in the Node.js runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getContext, startWorker } = await import("./lib/context");
    // Open the database at boot so a bad config or an unreachable Postgres shows up in the logs right away.
    getContext().catch((error) => console.error("[keel] no se pudo abrir la base de datos", error));
    startWorker();
  }
}
