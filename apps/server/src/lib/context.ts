import { openDb } from "./db";
import { type DokployClient, HttpDokployClient } from "./dokploy";
import { type Env, loadEnv } from "./env";
import { Store } from "./store";
import { DeployWorker } from "./worker";

export interface AppContext {
  env: Env;
  store: Store;
  dokploy: DokployClient;
  worker: DeployWorker;
  now: () => Date;
}

const WORKER_INTERVAL_MS = 5_000;

// Cached on globalThis so dev-mode module reloads reuse one DB connection and one worker loop.
const globalForKeel = globalThis as typeof globalThis & { keel?: AppContext; keelTimer?: NodeJS.Timeout };

export function getContext(): AppContext {
  if (!globalForKeel.keel) {
    const env = loadEnv();
    const store = new Store(openDb(env.KEEL_DB_PATH));
    const dokploy = new HttpDokployClient(env.DOKPLOY_URL, env.DOKPLOY_API_KEY);
    const worker = new DeployWorker(store, dokploy, {
      ciExpiryMinutes: env.KEEL_CI_EXPIRY_MINUTES,
      deployTimeoutMinutes: env.KEEL_DEPLOY_TIMEOUT_MINUTES,
    });
    globalForKeel.keel = { env, store, dokploy, worker, now: () => new Date() };
  }
  return globalForKeel.keel;
}

export function startWorker(): void {
  if (globalForKeel.keelTimer) return;
  const { worker } = getContext();
  globalForKeel.keelTimer = setInterval(() => {
    worker.tick().catch((error) => console.error("[keel] worker tick falló", error));
  }, WORKER_INTERVAL_MS);
}
