/**
 * Recognition must not decode or re-encode a stored essay photo.
 *
 * New uploads are uprighted in the browser (`prepareImageForCloudUpload`)
 * before they are stored. Doing the same work here with pure JavaScript
 * (full JPEG decode, per-pixel rotation, quality-92 encode) exceeds the
 * Worker CPU limit on a few 1500×2000 pages and kills the isolate before
 * it can record why the job stopped. Legacy photos that were stored
 * sideways are sent to the vision model unchanged.
 */
export async function uprightRecognitionImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  return { bytes, mimeType };
}
