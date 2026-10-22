import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

export function chunkItems<T>(items: readonly T[], size = BATCH_REANALYSIS_LIMIT): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new TypeError("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
