"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  MAX_REVIEW_IMAGES,
  PRIVACY_NOTICE_VERSION,
  type AssignmentConfig,
} from "@/src/domain/contracts";
import { ClassInput } from "../../components/ClassInput";
import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { AssignmentGuidancePanel } from "../../components/AssignmentGuidancePanel";
import { ErrorBanner } from "../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../lib/api";
import { prepareImageForCloudUpload } from "../../lib/image-upload-transform";

const presetConfig: AssignmentConfig = {
  title: "为自己鼓掌",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件让自己获得成长或勇气的亲身经历，叙事具体，感情真实。",
  targetCharacters: 600,
  structureRequirements: "围绕一件事展开，过程有波折，结尾写出成长感受。",
  scoringFocus: "审题立意、事件完整、细节描写与真情实感。",
  templateType: "preset_self_applause",
  sampleParagraphCount: 5,
};

const customConfig: AssignmentConfig = {
  title: "",
  grade: "上海五四学制六年级",
  writingRequirements: "",
  targetCharacters: 600,
  structureRequirements: "",
  scoringFocus: "",
  templateType: "custom",
  sampleParagraphCount: 5,
};

interface PendingImage {
  key: string;
  file: File;
  previewUrl: string;
  rotation: 0 | 90 | 180 | 270;
}

interface UploadedImage { id: number; position: number }
interface ReviewSession { id: string; revision: number }
interface ImageMutationResult { images: UploadedImage[]; revision: number }
interface SavedAssignment {
  id: string;
  config: AssignmentConfig;
}

function validateConfig(config: AssignmentConfig): string {
  if (!config.title.trim()) return "请填写作文题目";
  if (!config.grade.trim()) return "请填写适用年级";
  if (!config.writingRequirements.trim()) return "请填写写作要求";
  if (!Number.isInteger(config.targetCharacters) || config.targetCharacters <= 0) return "目标字数必须是正整数";
  if (!config.structureRequirements.trim()) return "请填写结构要求";
  if (!config.scoringFocus.trim()) return "请填写评分侧重";
  return "";
}

export default function NewReviewPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [config, setConfig] = useState<AssignmentConfig>(presetConfig);
  const [studentName, setStudentName] = useState("");
  const [className, setClassName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [documentName, setDocumentName] = useState("");
  const previewRef = useRef<PendingImage[]>([]);
  const mountedRef = useRef(true);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [review, setReview] = useState<ReviewSession | null>(null);
  const savedInputRef = useRef<{ config: AssignmentConfig; studentName: string; className: string } | null>(null);
  const [uploaded, setUploaded] = useState<UploadedImage[] | null>(null);
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [savedAssignments, setSavedAssignments] = useState<SavedAssignment[]>([]);
  const [savedAssignmentsLoaded, setSavedAssignmentsLoaded] = useState(false);
  const [deletingAssignmentId, setDeletingAssignmentId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void apiFetch<SavedAssignment[]>("/api/saved-assignments")
      .then((assignments) => {
        if (active) setSavedAssignments(assignments);
      })
      .catch(() => {
        // The core new-review flow remains usable if saved templates are unavailable.
      })
      .finally(() => {
        if (active) setSavedAssignmentsLoaded(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => { previewRef.current = images; }, [images]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; previewRef.current.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl)); };
  }, []);

  async function chooseDocument(file?: File) {
    if (!file || importing) return;
    setImporting(true); setError(""); setImportProgress("正在读取文档…");
    try {
      const { importDocument } = await import("../../lib/document-import");
      const pages = await importDocument(file, (message) => { if (mountedRef.current) setImportProgress(message); });
      if (!mountedRef.current) return;
      chooseFiles(pages);
      setDocumentName(file.name);
    } catch (caught) { if (mountedRef.current) setError(errorMessage(caught)); }
    finally { if (mountedRef.current) { setImporting(false); setImportProgress(""); } }
  }

  function updateConfig<K extends keyof AssignmentConfig>(key: K, value: AssignmentConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function deleteSavedAssignment(id: string) {
    setDeletingAssignmentId(id);
    setError("");
    try {
      await apiFetch(`/api/saved-assignments/${encodeURIComponent(id)}`, { method: "DELETE" });
      setSavedAssignments((current) => current.filter((assignment) => assignment.id !== id));
    } catch (caught) {
      setError(`${errorMessage(caught)}。暂时无法删除该题目。`);
    } finally {
      setDeletingAssignmentId(null);
    }
  }

  function chooseFiles(files: File[]) {
    setError("");
    if (files.length < 1 || files.length > MAX_REVIEW_IMAGES) {
      setError(`请选择 1 至 ${MAX_REVIEW_IMAGES} 张作文图片`);
      return;
    }
    images.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
    setDocumentName("");
    setImages(files.map((file, index) => ({
      key: `${file.name}-${file.lastModified}-${index}`,
      file,
      previewUrl: URL.createObjectURL(file),
      rotation: 0,
    })));
    setUploaded(null);
  }

  function addCameraFiles(files: File[]) {
    setError("");
    if (files.length !== 1) {
      setError("请一次拍摄一张作文图片");
      return;
    }
    if (images.length >= MAX_REVIEW_IMAGES) {
      setError(`最多上传 ${MAX_REVIEW_IMAGES} 张作文图片`);
      return;
    }
    const [file] = files;
    setImages((current) => [...current, {
      key: `${file.name}-${file.lastModified}-${current.length}`,
      file,
      previewUrl: URL.createObjectURL(file),
      rotation: 0,
    }]);
    setUploaded(null);
  }

  function move(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= images.length) return;
    setImages((current) => {
      const copy = [...current];
      [copy[index], copy[destination]] = [copy[destination], copy[index]];
      return copy;
    });
    setUploaded(null);
  }

  function updateImage(index: number, change: Partial<PendingImage>) {
    setImages((current) => current.map((image, imageIndex) => imageIndex === index ? { ...image, ...change } : image));
    setUploaded(null);
  }

  function removeImage(index: number) {
    URL.revokeObjectURL(images[index].previewUrl);
    setImages((current) => current.filter((_, imageIndex) => imageIndex !== index));
    setUploaded(null);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    let submittingAnalysis = false;
    try {
      let currentReview = review;
      if (!currentReview) {
        currentReview = await apiFetch<ReviewSession>("/api/reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config, studentName, className }),
        });
        setReview(currentReview);
      } else if (savedInputRef.current?.config !== config || savedInputRef.current?.studentName !== studentName || savedInputRef.current?.className !== className) {
        currentReview = await apiFetch<ReviewSession>(`/api/reviews/${encodeURIComponent(currentReview.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: currentReview.revision,
            config,
            studentName,
            className,
          }),
        });
        setReview(currentReview);
      }
      savedInputRef.current = { config, studentName, className };
      if (!uploaded) {
        const form = new FormData();
        form.append("expectedRevision", String(currentReview.revision));
        form.append("privacyConfirmed", String(privacyConfirmed));
        form.append("privacyNoticeVersion", PRIVACY_NOTICE_VERSION);
        const prepared = await Promise.all(images.map(async (image) => prepareImageForCloudUpload({ file: image.file, rotation: image.rotation, crop: null })));
        prepared.forEach(({ file }) => form.append("images", file));
        form.append("imageMeta", JSON.stringify(prepared.map(({ width, height }) => ({ width, height }))));
        const uploadResult = await apiFetch<ImageMutationResult>(`/api/reviews/${encodeURIComponent(currentReview.id)}/images`, {
          method: "POST",
          body: form,
        });
        setUploaded([...uploadResult.images].sort((a, b) => a.position - b.position));
        currentReview = { ...currentReview, revision: uploadResult.revision };
        setReview(currentReview);
      }
      submittingAnalysis = true;
      setStartingAnalysis(true);
      await apiFetch(`/api/reviews/${encodeURIComponent(currentReview.id)}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
      router.push(`/reviews?id=${encodeURIComponent(currentReview.id)}`);
    } catch (caught) {
      setError(submittingAnalysis
        ? `${errorMessage(caught)}。作文已保存，尚未确认分析已启动，可直接重试。`
        : `${errorMessage(caught)}。已保留当前内容，可直接重试。`);
    } finally {
      setBusy(false);
      setStartingAnalysis(false);
    }
  }

  function nextFromConfig() {
    const message = validateConfig(config);
    setError(message);
    if (!message) setStep(2);
  }

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="flow-page">
        <div className="page-title"><p className="eyebrow">新建批改</p><h1>把作文铺到案头</h1><p>三步完成题目设定、作文上传与提交。</p></div>
        <ol className="stepper" aria-label="新建进度">
          {["题目", "作文上传", "确认"].map((label, index) => (
            <li key={label} aria-current={step === index + 1 ? "step" : undefined} className={step >= index + 1 ? "stepper-active" : ""}><span>{index + 1}</span>{label}</li>
          ))}
        </ol>
        {error ? <ErrorBanner message={error} /> : null}

        {step === 1 ? (
          <section className="paper-card flow-card" aria-labelledby="assignment-heading">
            <div className="section-heading"><div><p className="eyebrow">第一步</p><h2 id="assignment-heading">选择作文题目</h2></div></div>
            <div className="template-grid">
              <button type="button" aria-label="使用内置题目《为自己鼓掌》" aria-pressed={config.templateType === "preset_self_applause"} className={`template-card ${config.templateType === "preset_self_applause" ? "selected" : ""}`} onClick={() => { setConfig(presetConfig); setError(""); }}>
                <span className="template-mark" aria-hidden="true">荐</span><strong>《为自己鼓掌》</strong><small>六年级 · 600 字 · 记叙文</small>
              </button>
              <button type="button" aria-label="自定义题目" aria-pressed={config.templateType === "custom"} className={`template-card ${config.templateType === "custom" ? "selected" : ""}`} onClick={() => { setConfig(customConfig); setError(""); }}>
                <span className="template-mark" aria-hidden="true">+</span><strong>自定义题目</strong><small>自行设置年级、结构与评分重点</small>
              </button>
            </div>
            {savedAssignments.length ? (
              <section className="saved-assignments" aria-labelledby="saved-assignment-heading">
                <div className="saved-assignment-heading"><div><p className="eyebrow">常用题目</p><h3 id="saved-assignment-heading">已保存的自定义题目</h3></div><small>选择后可继续修改</small></div>
                <div className="saved-assignment-list">
                  {savedAssignments.map((assignment) => (
                    <article className="saved-assignment-card" key={assignment.id}>
                      <button type="button" className="saved-assignment-select" aria-label={`使用已保存题目${assignment.config.title}`} onClick={() => { setConfig({ ...assignment.config, templateType: "custom" }); setError(""); }}>
                        <strong>{assignment.config.title}</strong><small>{assignment.config.grade} · {assignment.config.targetCharacters} 字</small>
                        <span>{assignment.config.writingRequirements}</span>
                      </button>
                      <button type="button" className="saved-assignment-delete" aria-label={`删除已保存题目${assignment.config.title}`} disabled={deletingAssignmentId === assignment.id} onClick={() => void deleteSavedAssignment(assignment.id)}>{deletingAssignmentId === assignment.id ? "删除中…" : "删除"}</button>
                    </article>
                  ))}
                </div>
              </section>
            ) : savedAssignmentsLoaded ? <p className="saved-assignment-empty">完成一次自定义题目批改后，题目要求会自动保存在这里。</p> : null}
            {config.templateType === "custom" ? (
              <div className="form-grid">
                <label>作文题目<input value={config.title} onChange={(event) => updateConfig("title", event.target.value)} /></label>
                <label>适用年级<input value={config.grade} onChange={(event) => updateConfig("grade", event.target.value)} /></label>
                <label>目标字数<input aria-label="目标字数" type="number" min={1} value={config.targetCharacters} onChange={(event) => updateConfig("targetCharacters", Number(event.target.value))} /></label>
                <AssignmentGuidancePanel config={config} onGenerated={(guidance) => setConfig((current) => ({ ...current, ...guidance }))} onError={setError} />
                <label className="wide">写作要求<textarea value={config.writingRequirements} onChange={(event) => updateConfig("writingRequirements", event.target.value)} /></label>
                <label className="wide">结构要求<textarea value={config.structureRequirements} onChange={(event) => updateConfig("structureRequirements", event.target.value)} /></label>
                <label className="wide">评分侧重<textarea value={config.scoringFocus} onChange={(event) => updateConfig("scoringFocus", event.target.value)} /></label>
              </div>
            ) : <div className="assignment-preview"><p><b>写作要求：</b>{config.writingRequirements}</p><p><b>重点：</b>{config.scoringFocus}</p></div>}
            <div className="form-actions"><button className="button button--primary" type="button" onClick={nextFromConfig}>下一步：上传作文</button></div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="paper-card flow-card" aria-labelledby="upload-heading">
            <div className="section-heading"><div><p className="eyebrow">第二步</p><h2 id="upload-heading">上传作文</h2></div><span className="muted">{images.length}/{MAX_REVIEW_IMAGES} 张</span></div>
            {importing ? <p role="status" className="document-import-notice">{importProgress}</p> : null}
            <fieldset className="upload-workspace" disabled={importing}>
            <ClassInput value={className} onChange={setClassName} />
            <label className="upload-student-name">学生姓名<input aria-label="学生姓名" maxLength={50} placeholder="请输入学生姓名" value={studentName} onChange={(event) => setStudentName(event.target.value)} /></label>
            <div className="upload-choices">
              <label className="upload-zone upload-zone--camera">使用手机相机拍照<input className="visually-hidden" aria-label="使用手机相机拍照" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { addCameraFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /><span>拍摄一页后可继续拍下一页</span><small>将优先打开后置相机</small></label>
              <label className="upload-zone">从相册或文件选择<input className="visually-hidden" aria-label="选择作文图片" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))} /><span>选择 1 至 {MAX_REVIEW_IMAGES} 张图片</span><small>支持 JPG、PNG、WebP，单张不超过 20MB</small></label>
            </div>
            <label className="upload-zone document-upload">直接上传 Word 或 PDF<input className="visually-hidden" aria-label="选择作文文档" type="file" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { void chooseDocument(event.target.files?.[0]); event.currentTarget.value = ""; }} /><span>每份文档对应一篇作文，最多 {MAX_REVIEW_IMAGES} 页、20MB</span><small>Word 会重新排版，PDF 按原页显示。导入后请逐页检查预览。</small></label>
            {documentName ? <p className="document-import-notice">已导入：{documentName}，共 {images.length} 页。重新选文件会替换当前作文。</p> : null}
            <div className="image-sort-list">
              {images.map((image, index) => (
                <article className="image-sort-card" key={image.key}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.previewUrl} alt={`${image.file.name} 预览`} style={{ transform: `rotate(${image.rotation}deg)` }} />
                  <div className="image-controls">
                    <div><b>第 {index + 1} 页 · {image.file.name}</b><small>{Math.max(1, Math.round(image.file.size / 1024))} KB</small></div>
                    <div className="compact-actions">
                      <button type="button" aria-label={`上移 ${image.file.name}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
                      <button type="button" aria-label={`下移 ${image.file.name}`} disabled={index === images.length - 1} onClick={() => move(index, 1)}>下移</button>
                      <button type="button" aria-label={`旋转 ${image.file.name}`} onClick={() => updateImage(index, { rotation: ((image.rotation + 90) % 360) as PendingImage["rotation"] })}>旋转 90°</button>
                      <button type="button" aria-label={`删除 ${image.file.name}`} onClick={() => removeImage(index)}>删除</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <div className="form-actions"><button className="button button--quiet" type="button" onClick={() => setStep(1)}>上一步</button><button className="button button--primary" type="button" disabled={images.length < 1} onClick={() => { setError(""); setStep(3); }}>下一步：确认提交</button></div>
            </fieldset>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="paper-card flow-card" aria-labelledby="confirm-heading">
            <p className="eyebrow">第三步</p><h2 id="confirm-heading">确认批改内容</h2>
            <div className="confirm-assignment"><span>作文题目</span><b>{config.title}</b><span>{config.grade} · 目标 {config.targetCharacters} 字</span><span>学生姓名</span><b>{studentName.trim() || "未填写"}</b><span>班级</span><b>{className.trim() || "未分类"}</b></div>
            <ol className="confirm-images" aria-label="图片提交顺序">{images.map((image, index) => <li key={image.key}><span>{index + 1}</span><b>{image.file.name}</b><small>旋转 {image.rotation}°</small></li>)}</ol>
            <div className="privacy-note"><b>真实作文上传说明</b><p>请勿在图片或文档中保留学生姓名、学号、班级、学校等无关身份信息；本次图片仅用于作文批改，并会发送到教师配置的第三方 AI 服务识别和分析。</p><p>作文图片与批改文件会长期保留，老师可在历史记录中手动永久删除；第三方 AI 服务的数据处理以其自身规则为准。</p><label><input aria-label="确认真实作文上传说明" type="checkbox" checked={privacyConfirmed} onChange={(event) => setPrivacyConfirmed(event.target.checked)} /> 我确认已获得上传和使用该作文的必要授权。</label></div>
            <div className="form-actions"><button className="button button--quiet" type="button" disabled={busy} onClick={() => setStep(2)}>上一步</button><AsyncButton className="button button--primary" type="button" busy={busy} busyLabel={startingAnalysis ? "正在启动 AI 分析…" : "正在建立批改…"} disabled={!privacyConfirmed} onClick={() => void submit()}>创建并开始批改</AsyncButton></div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
