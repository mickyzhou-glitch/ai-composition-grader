const MAX_INLINE_AI_IMAGE_BYTES = 12 * 1024 * 1024;

export interface AiImageObject {
  key: string;
  mimeType: string;
}

function toBase64(bytes: Uint8Array): string {
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
  const started = Date.now();
  let totalSize = 0;
  const urls: string[] = [];
  for (const image of images) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) throw new Error("AI_IMAGE_UNSUPPORTED");
    const object = await bucket.get(image.key);
    if (!object) throw new Error("AI_IMAGE_UNAVAILABLE");
    totalSize += object.size;
    if (totalSize > MAX_INLINE_AI_IMAGE_BYTES) throw new Error("AI_INLINE_IMAGE_TOO_LARGE");
    // Bytes are already upright when uploaded from the browser. Do not decode
    // or rotate them here; a full JPEG re-encode blows the Worker CPU budget.
    const bytes = new Uint8Array(await object.arrayBuffer());
    urls.push(`data:${image.mimeType};base64,${toBase64(bytes)}`);
  }
  console.info(JSON.stringify({
    event: "analysis_images_inlined",
    count: images.length,
    bytes: totalSize,
    durationMs: Date.now() - started,
  }));
  return urls;
}
