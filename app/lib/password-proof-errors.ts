export function isPasswordProofModuleLoadError(cause: unknown): boolean {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return /chunkloaderror|dynamically imported module|failed to fetch|loading chunk|load failed|networkerror|importing a module script failed/iu.test(detail);
}
