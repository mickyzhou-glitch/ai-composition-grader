export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  ANALYSIS_QUEUE: Queue;
  ANALYSIS_DLQ: Queue;
  APP_ORIGIN: string;
  AUTH_PROOF_ENCRYPTION_KEY: string;
  AUTH_IP_HMAC_SECRET: string;
  AI_API_KEY: string;
}

export function readWorkerEnv(env: WorkerEnv): WorkerEnv {
  for (const key of ["AUTH_PROOF_ENCRYPTION_KEY", "AUTH_IP_HMAC_SECRET", "AI_API_KEY"] as const) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  return env;
}
