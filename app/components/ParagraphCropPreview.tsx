"use client";

/* eslint-disable @next/next/no-img-element -- Canvas crops render through generated object URLs. */

import { useEffect, useState } from "react";

import type { PublicOcrView } from "@/src/ocr/contracts";
import { cropImageRegion } from "../lib/image-crop";

type OcrV2 = Extract<PublicOcrView, { version: 2 }>;
type Segment = OcrV2["paragraphs"][number]["segments"][number];

interface CropPreviewImage {
  id: number;
  position: number;
}

interface PreviewCrop {
  pageIndex: number;
  url: string;
  width: number;
  height: number;
}

interface PreviewState {
  key: string;
  crops: PreviewCrop[];
  error: string;
}

interface PreviewInputSnapshot {
  reviewId: string;
  paragraphNumber: number;
  images: Array<{ id: number; position: number }>;
  segments: Segment[];
}

const inflightPageBlobs = new Map<string, Promise<Blob>>();

function fetchPageBlob(url: string, errorMessage: string): Promise<Blob> {
  const existing = inflightPageBlobs.get(url);
  if (existing) return existing;
  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(errorMessage);
      return response.blob();
    })
    .finally(() => {
      inflightPageBlobs.delete(url);
    });
  inflightPageBlobs.set(url, request);
  return request;
}

export function ParagraphCropPreview({
  reviewId,
  paragraphNumber,
  images,
  segments,
}: {
  reviewId: string;
  paragraphNumber: number;
  images: CropPreviewImage[];
  segments: Segment[];
}) {
  const previewKey = JSON.stringify({
    reviewId,
    paragraphNumber,
    images: images.map(({ id, position }) => ({ id, position })),
    segments,
  });
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const snapshot = JSON.parse(previewKey) as PreviewInputSnapshot;

    void Promise.all(snapshot.segments.map(async (segment) => {
      const errorMessage = `第 ${snapshot.paragraphNumber} 段第 ${segment.pageIndex + 1} 页裁图失败`;
      const image = snapshot.images.find(({ position }) => position === segment.pageIndex);
      if (!image) throw new Error(errorMessage);
      const blob = await fetchPageBlob(
        `/api/reviews/${encodeURIComponent(snapshot.reviewId)}/files?imageId=${image.id}&variant=ai`,
        errorMessage,
      );
      const bitmap = await createImageBitmap(blob);
      try {
        const crop = await cropImageRegion(bitmap, segment);
        if (!active) return { pageIndex: segment.pageIndex, url: "", width: crop.width, height: crop.height };
        const url = URL.createObjectURL(new Blob([crop.bytes.slice().buffer], {
          type: "image/png",
        }));
        objectUrls.push(url);
        return { pageIndex: segment.pageIndex, url, width: crop.width, height: crop.height };
      } finally {
        bitmap.close();
      }
    })).then((loaded) => {
      if (active) setPreview({ key: previewKey, crops: loaded, error: "" });
    }).catch((caught) => {
      if (!active) return;
      setPreview({
        key: previewKey,
        crops: [],
        error: caught instanceof Error
          ? caught.message
          : `第 ${snapshot.paragraphNumber} 段裁图失败`,
      });
    });

    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previewKey]);

  const crops = preview?.key === previewKey ? preview.crops : [];
  const error = preview?.key === previewKey ? preview.error : "";
  if (error) return <div className="paragraph-crop-error" role="alert">{error}</div>;
  if (crops.length !== segments.length) {
    return <div className="paragraph-crop-loading" role="status">正在加载原文裁图…</div>;
  }
  return (
    <div className="paragraph-crop-list">
      {crops.map((crop, index) => (
        <figure className="paragraph-crop" key={`${crop.pageIndex}:${index}`}>
          {index > 0 ? <figcaption>第 {crop.pageIndex + 1} 页续</figcaption> : null}
          <img
            src={crop.url}
            alt={`第 ${paragraphNumber} 段原文裁图，第 ${crop.pageIndex + 1} 页`}
            width={crop.width}
            height={crop.height}
          />
        </figure>
      ))}
    </div>
  );
}
