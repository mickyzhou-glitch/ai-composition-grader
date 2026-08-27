"use client";

import { useEffect, useState } from "react";

import { apiFetch, errorMessage } from "@/app/lib/api";
import { buildDeliveryDocument } from "@/app/lib/delivery-document";
import type { ReviewView } from "@/app/lib/types";
import type { DeliveryDocument } from "@/src/delivery/contracts";

import { PrintReview } from "./PrintReview";

interface PrintData {
  document: DeliveryDocument;
  cropSources: string[][];
}

function cropBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" });
}

async function decodeSource(source: string): Promise<void> {
  const image = new Image();
  image.src = source;
  await image.decode();
}

export function PrintReviewPage({ reviewId }: { reviewId: string }) {
  const [printData, setPrintData] = useState<PrintData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let released = false;
    const objectUrls: string[] = [];
    const release = () => {
      if (released) return;
      released = true;
      objectUrls.forEach((source) => URL.revokeObjectURL(source));
    };

    void (async () => {
      try {
        const review = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`);
        const document = await buildDeliveryDocument(review);
        const cropSources = document.paragraphs.map(({ crops }) => crops.map(({ bytes }) => {
          const source = URL.createObjectURL(cropBlob(bytes));
          objectUrls.push(source);
          return source;
        }));
        await Promise.all(cropSources.flat().map(decodeSource));
        if (active) setPrintData({ document, cropSources });
        else release();
      } catch (caught) {
        if (active) setError(errorMessage(caught));
        else release();
      }
    })();

    return () => {
      active = false;
      release();
    };
  }, [reviewId]);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!printData) return <main aria-busy="true" />;
  return <PrintReview document={printData.document} cropSources={printData.cropSources} />;
}
