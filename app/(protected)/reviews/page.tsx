import { Suspense } from "react";

import { ReviewRoute } from "./ReviewRoute";

export default function ReviewsPage() {
  return <Suspense fallback={<main className="page-shell" aria-busy="true" />}><ReviewRoute /></Suspense>;
}
