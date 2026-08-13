export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  ANALYSIS_QUEUE: Queue;
  ANALYSIS_DLQ: Queue;
  APP_ORIGIN: string;
  AUTH_PROOF_ENCRYPTION_KEY: string;
  AUTH_IP_HMAC_SECRET: string;
  VISION_AI_API_KEY?: string;
  CONTENT_AI_API_KEY?: string;
  AI_API_KEY?: string;
  AI_FILE_URL_SECRET: string;
}

export function readWorkerEnv(env: WorkerEnv): WorkerEnv {
  for (const key of ["AUTH_PROOF_ENCRYPTION_KEY", "AUTH_IP_HMAC_SECRET", "AI_FILE_URL_SECRET"] as const) {
    if (!env[key]) throw new Error(`${key} is required`);
  }
  if (!env.AI_API_KEY && (!env.VISION_AI_API_KEY || !env.CONTENT_AI_API_KEY)) {
    throw new Error("VISION_AI_API_KEY and CONTENT_AI_API_KEY are required when AI_API_KEY is unset");
  }
  return env;
}
