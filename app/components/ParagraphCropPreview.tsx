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
  const previewKey = JSON.stringify({ reviewId, paragraphNumber, images, segments });
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];

    void Promise.all(segments.map(async (segment) => {
      const image = images.find(({ position }) => position === segment.pageIndex);
      if (!image) throw new Error(`第 ${paragraphNumber} 段第 ${segment.pageIndex + 1} 页裁图失败`);
      const response = await fetch(
        `/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${image.id}&variant=ai`,
      );
      if (!response.ok) {
        throw new Error(`第 ${paragraphNumber} 段第 ${segment.pageIndex + 1} 页裁图失败`);
      }
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const crop = await cropImageRegion(bitmap, segment);
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
          : `第 ${paragraphNumber} 段裁图失败`,
      });
    });

    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [images, paragraphNumber, previewKey, reviewId, segments]);

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
