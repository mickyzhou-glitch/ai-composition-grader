import { createBatchReviewPdfRouteHandlers } from "@/src/api/handlers";
import { PdfBatchService } from "@/src/pdf/pdf-batch-service";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return runProtectedApi(request, (user) => {
    const services = getApplicationServices();
    return createBatchReviewPdfRouteHandlers({
      ownerId: user.id,
      pdfBatchService: new PdfBatchService(services.pdfService),
    }).POST(request);
  }, { write: true });
}
