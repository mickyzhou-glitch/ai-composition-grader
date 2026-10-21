import { useEffect, useRef, useState } from "react";

import {
  MAX_TEXTBOOK_IMAGES,
  MAX_TEXTBOOK_SOURCE_BYTES,
  MAX_TEXTBOOK_IMAGE_BYTES,
  TEXTBOOK_IMAGE_TYPES,
  type AssignmentGuidance,
} from "@/src/domain/assignment-guidance";
import type { AssignmentConfig } from "@/src/domain/contracts";
import { apiFetch, errorMessage } from "../lib/api";
import { prepareImageForCloudUpload } from "../lib/image-upload-transform";
import { AsyncButton } from "./AsyncButton";

interface TextbookImage { key: string; file: File; previewUrl: string }

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("课本图片读取失败"));
    reader.onerror = () => reject(new Error("课本图片读取失败，请重新选择"));
    reader.readAsDataURL(file);
  });
}

export function AssignmentGuidancePanel({ config, onGenerated, onError }: {
  config: AssignmentConfig;
  onGenerated: (guidance: AssignmentGuidance) => void;
  onError: (message: string) => void;
}) {
  const [images, setImages] = useState<TextbookImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState(false);
  const imagesRef = useRef<TextbookImage[]>([]);
  const activeRef = useRef(true);
  const configRef = useRef(config);

  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      imagesRef.current.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
    };
  }, []);

  function chooseImages(files: File[]) {
    if (!files.length || busy) return;
    onError("");
    if (images.length + files.length > MAX_TEXTBOOK_IMAGES) {
      onError(`最多上传 ${MAX_TEXTBOOK_IMAGES} 张课本图片`);
      return;
    }
    if (files.some((file) => !TEXTBOOK_IMAGE_TYPES.includes(file.type))) {
      onError("课本图片仅支持 JPG、PNG、WebP 格式");
      return;
    }
    if (files.some((file) => file.size === 0 || file.size > MAX_TEXTBOOK_SOURCE_BYTES)) {
      onError("请选择非空的课本图片，单张不超过 20MB");
      return;
    }
    const next = [...images, ...files.map((file) => ({
      key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file),
    }))];
    imagesRef.current = next;
    setImages(next);
    setGenerated(false);
  }

  function removeImage(key: string) {
    const image = images.find((image) => image.key === key);
    if (image) URL.revokeObjectURL(image.previewUrl);
    const next = images.filter((image) => image.key !== key);
    imagesRef.current = next;
    setImages(next);
    setGenerated(false);
    onError("");
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    setGenerated(false);
    onError("");
    try {
      const textbookImages: string[] = [];
      for (const image of images) {
        const { file } = await prepareImageForCloudUpload({ file: image.file, rotation: 0, crop: null });
        if (file.size > MAX_TEXTBOOK_IMAGE_BYTES) throw new Error("课本图片压缩后仍过大，请裁剪到习作区域或缩小图片后重试");
        textbookImages.push(await dataUrl(file));
      }
      if (!activeRef.current) return;
      const guidance = await apiFetch<AssignmentGuidance>("/api/assignment-guidance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: config.title, grade: config.grade, targetCharacters: config.targetCharacters,
          ...(textbookImages.length ? { textbookImages } : {}),
        }),
      });
      if (!activeRef.current) return;
      if (configRef.current !== config) throw new Error("题目或要求已修改，请按当前内容重新生成");
      // Keep a teacher-supplied title even if the model suggests another one.
      onGenerated({ ...guidance, ...(config.title.trim() ? { title: config.title } : {}) });
      setGenerated(true);
    } catch (error) {
      if (activeRef.current) onError(`${errorMessage(error)}。已保留当前内容，可重试或手动填写。`);
    } finally {
      if (activeRef.current) setBusy(false);
    }
  }

  return (
    <div className="wide ai-guidance-panel">
      <div className="ai-guidance-action">
        <div><b>先由 AI 拟定要求</b><small>根据题目生成初稿，或上传课本图片直接导入习作要求；生成后可继续手动修改。</small></div>
        <AsyncButton className="button button--quiet" type="button" busy={busy} busyLabel={images.length ? "AI 正在读取课本…" : "AI 正在拟定…"} disabled={!config.title.trim() && !images.length} onClick={() => void generate()}>AI 生成要求</AsyncButton>
      </div>
      <div className="textbook-upload">
        <div className="textbook-upload-heading">
          <div><b>从课本导入</b><small>拍下或截取课本的习作页面，可自动补全题目、字数和要求。</small></div>
          <label className={`button button--quiet file-label ${busy || images.length >= MAX_TEXTBOOK_IMAGES ? "textbook-upload-disabled" : ""}`}>
            {images.length ? "继续添加图片" : "添加课本图片"}
            <input className="visually-hidden" aria-label="选择课本图片" type="file" accept={TEXTBOOK_IMAGE_TYPES.join(",")} multiple disabled={busy || images.length >= MAX_TEXTBOOK_IMAGES} onChange={(event) => { chooseImages(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
          </label>
        </div>
        <p className="textbook-upload-hint">支持 JPG、PNG、WebP，最多 {MAX_TEXTBOOK_IMAGES} 张，单张不超过 20MB。请确保文字清晰，按课本页序添加。</p>
        {images.length ? <ul className="textbook-previews" aria-label="课本图片">
          {images.map((image, index) => <li key={image.key}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.previewUrl} alt={`课本第 ${index + 1} 页：${image.file.name}`} />
            <div><span title={image.file.name}>{index + 1}. {image.file.name}</span><button type="button" aria-label={`移除课本图片 ${image.file.name}`} disabled={busy} onClick={() => removeImage(image.key)}>移除</button></div>
          </li>)}
        </ul> : null}
        {busy ? <p className="textbook-upload-status" role="status">{images.length ? "正在读取课本并整理要求，请稍候…" : "正在拟定要求，请稍候…"}</p> : generated ? <p className="textbook-upload-status" role="status">已填入下方，可核对并继续修改。</p> : null}
      </div>
    </div>
  );
}
