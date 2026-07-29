const MAX_INLINE_AI_IMAGE_BYTES = 12 * 1024 * 1024;

export interface AiImageObject {
  key: string;
  mimeType: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Some OpenAI-compatible gateways block fetching signed private URLs. The
 * image remains private in R2; only its data is sent to the configured AI API.
 */
export async function loadInlineAiImageUrls(bucket: R2Bucket, images: AiImageObject[]): Promise<string[]> {
  let totalSize = 0;
  const urls: string[] = [];
  for (const image of images) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) throw new Error("AI_IMAGE_UNSUPPORTED");
    const object = await bucket.get(image.key);
    if (!object) throw new Error("AI_IMAGE_UNAVAILABLE");
    totalSize += object.size;
    if (totalSize > MAX_INLINE_AI_IMAGE_BYTES) throw new Error("AI_INLINE_IMAGE_TOO_LARGE");
    urls.push(`data:${image.mimeType};base64,${toBase64(await object.arrayBuffer())}`);
  }
  return urls;
}
