"use client";

import { useParams } from "next/navigation";

import { PrintReviewPage } from "./PrintReviewPage";

export default function PrintReviewRoute() {
  const { id } = useParams<{ id: string }>();
  return <PrintReviewPage reviewId={String(id)} />;
}
