import { MAX_REVIEW_IMAGES } from "@/src/domain/contracts";

export function validateDocumentFile(file: File): "pdf" | "docx" {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "pdf" && extension !== "docx") throw new Error("请选择 Word（.docx）或 PDF 文档");
  if (!file.size) throw new Error("文档为空，请重新选择");
  if (file.size > 20 * 1024 * 1024) throw new Error("单份文档不能超过 20MB");
  return extension;
}

export function validateDocumentPageCount(count: number) {
  if (!Number.isInteger(count) || count < 1) throw new Error("文档没有可导入的正文或图片");
  if (count > MAX_REVIEW_IMAGES) throw new Error(`每篇作文最多 ${MAX_REVIEW_IMAGES} 页，请拆分文档后再上传`);
}

async function canvasFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("页面转换失败，请重试")), "image/jpeg", 0.92));
  return new File([blob], name, { type: "image/jpeg" });
}

async function importPdf(file: File, progress: (message: string) => void): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: "/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/",
  });
  // Stop encrypted files immediately instead of leaving an unresolved password prompt.
  loading.onPassword = () => { void loading.destroy(); };
  try {
    const pdf = await loading.promise;
    validateDocumentPageCount(pdf.numPages);
    const files: File[] = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      progress(`正在转换 PDF：第 ${index}/${pdf.numPages} 页…`);
      const page = await pdf.getPage(index);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2.5, 2200 / Math.max(original.width, original.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        files.push(await canvasFile(canvas, `${file.name}-第${index}页.jpg`));
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
    return files;
  } catch (error) {
    if (error instanceof Error && /password|destroyed/i.test(error.message)) throw new Error("请先解除 PDF 密码保护，再上传");
    throw error;
  } finally { await loading.destroy(); }
}

async function importWord(file: File, progress: (message: string) => void): Promise<File[]> {
  const mammoth = await import("mammoth/mammoth.browser");
  progress("正在读取 Word 正文和图片…");
  const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { externalFileAccess: false });
  // Never insert untrusted document HTML into the live page. Only text and embedded raster images are drawn.
  const parsed = new DOMParser().parseFromString(result.value, "text/html");
  const canvas = document.createElement("canvas");
  canvas.width = 1440; canvas.height = 2036;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持文档预览，请更新浏览器");
  const files: File[] = [];
  let y = 120;
  let hasContent = false;
  let line = "";
  const width = 1200;
  function reset() {
    context!.fillStyle = "#ffffff"; context!.fillRect(0, 0, canvas.width, canvas.height);
    context!.fillStyle = "#151515"; context!.font = '32px "Microsoft YaHei", "PingFang SC", sans-serif';
    context!.textBaseline = "top";
    y = 120; hasContent = false;
  }
  async function finish() {
    if (!hasContent) return;
    validateDocumentPageCount(files.length + 1);
    files.push(await canvasFile(canvas, `${file.name}-第${files.length + 1}页.jpg`));
    progress(`正在整理 Word：已生成 ${files.length} 页…`);
    reset();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  async function newline() {
    if (y + 52 > canvas.height - 120) await finish();
    if (line) { context!.fillText(line, 120, y); hasContent = true; }
    line = ""; y += 52;
  }
  async function text(value: string) {
    for (const character of value) {
      if (character === "\n") { await newline(); continue; }
      if (context!.measureText(line + character).width > width) await newline();
      line += character;
    }
  }
  async function walk(node: Node): Promise<void> {
    if (node.nodeType === Node.TEXT_NODE) { await text(node.textContent ?? ""); return; }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "object"].includes(tag)) return;
    if (tag === "br") { await newline(); return; }
    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      if (!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(src)) throw new Error("Word 中包含无法预览的图片，请另存为 PDF 后上传");
      if (line) await newline();
      const image = new Image();
      image.src = src;
      await image.decode();
      const scale = Math.min(width / image.naturalWidth, (canvas.height - 240) / image.naturalHeight, 2);
      const imageWidth = image.naturalWidth * scale;
      const imageHeight = image.naturalHeight * scale;
      if (y + imageHeight > canvas.height - 120) await finish();
      context!.drawImage(image, 120, y, imageWidth, imageHeight);
      y += imageHeight + 24; hasContent = true;
      return;
    }
    for (const child of Array.from(node.childNodes)) await walk(child);
    if (["p", "li", "h1", "h2", "h3", "tr"].includes(tag)) {
      if (line) await newline();
      y += 18;
    } else if (["td", "th"].includes(tag)) await text("　");
  }
  try {
    reset();
    for (const child of Array.from(parsed.body.childNodes)) await walk(child);
    if (line) await newline();
    await finish();
    validateDocumentPageCount(files.length);
    return files;
  } finally { canvas.width = 0; canvas.height = 0; }
}

export async function importDocument(file: File, progress: (message: string) => void): Promise<File[]> {
  const format = validateDocumentFile(file);
  progress("正在准备文档预览…");
  try { return await (format === "pdf" ? importPdf(file, progress) : importWord(file, progress)); }
  catch (error) {
    if (error instanceof Error && /最多|没有可|密码|不支持|无法预览/.test(error.message)) throw error;
    throw new Error("文档读取失败，请确认文件未损坏；Word 也可另存为 PDF 后重试");
  }
}
