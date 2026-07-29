export function shouldUsePasswordProofLogin(hostname: string): boolean {
  return hostname.endsWith(".workers.dev");
}
