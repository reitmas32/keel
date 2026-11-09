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

// Cached on globalThis so dev-mode module reloads reuse one DB connection (or pool) and one worker loop.
const globalForKeel = globalThis as typeof globalThis & {
  keel?: Promise<AppContext>;
  keelTimer?: NodeJS.Timeout;
};

async function createContext(): Promise<AppContext> {
  const env = loadEnv();
  // Opening the database also applies its pending migrations, so nothing queries an outdated schema.
  const store = new Store(await openDb(env));
  const dokploy = new HttpDokployClient(env.DOKPLOY_URL, env.DOKPLOY_API_KEY);
  const worker = new DeployWorker(store, dokploy, {
    ciExpiryMinutes: env.KEEL_CI_EXPIRY_MINUTES,
    deployTimeoutMinutes: env.KEEL_DEPLOY_TIMEOUT_MINUTES,
  });
  return { env, store, dokploy, worker, now: () => new Date() };
}

export function getContext(): Promise<AppContext> {
  if (!globalForKeel.keel) {
    globalForKeel.keel = createContext().catch((error) => {
      // Don't cache the failure (e.g. Postgres still starting): the next request tries again.
      globalForKeel.keel = undefined;
      throw error;
    });
  }
  return globalForKeel.keel;
}

export function startWorker(): void {
  if (globalForKeel.keelTimer) return;
  globalForKeel.keelTimer = setInterval(() => {
    getContext()
      .then(({ worker }) => worker.tick())
      .catch((error) => console.error("[keel] worker tick falló", error));
  }, WORKER_INTERVAL_MS);
}
