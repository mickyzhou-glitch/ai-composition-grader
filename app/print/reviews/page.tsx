import { Suspense } from "react";

import { PrintReviewRoute } from "./PrintReviewRoute";

export default function PrintReviewsPage() {
  return <Suspense fallback={<main aria-busy="true" />}><PrintReviewRoute /></Suspense>;
}
