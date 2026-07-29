import type { NormalizedCrop } from "@/src/domain/contracts";

export async function prepareImageForCloudUpload(input: { file: File; rotation: 0 | 90 | 180 | 270; crop: NormalizedCrop | null }): Promise<{ file: File; width: number; height: number }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.file.type)) {
    throw new TypeError("仅支持 JPG、PNG、WebP 图片");
  }
  if (typeof createImageBitmap !== "function") {
    return { file: input.file, width: 1, height: 1 };
  }
  const source = await createImageBitmap(input.file);
  try {
    const crop = input.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const sourceWidth = Math.max(1, Math.round(source.width * crop.width));
    const sourceHeight = Math.max(1, Math.round(source.height * crop.height));
    const width = input.rotation === 90 || input.rotation === 270 ? sourceHeight : sourceWidth;
    const height = input.rotation === 90 || input.rotation === 270 ? sourceWidth : sourceHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片处理");
    context.translate(width / 2, height / 2);
    context.rotate((input.rotation * Math.PI) / 180);
    context.drawImage(source, Math.round(source.width * crop.x), Math.round(source.height * crop.y), sourceWidth, sourceHeight, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片转换失败")), "image/jpeg", 0.9));
    return { file: new File([blob], input.file.name.replace(/\.[^.]+$/u, "") + ".jpg", { type: "image/jpeg" }), width, height };
  } finally {
    source.close();
  }
}
