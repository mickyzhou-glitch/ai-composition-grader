import { OpenAIReviewAdapter } from "../ai/openai-review-adapter";
import { PdfService } from "../pdf/pdf-service";
import { openAppDatabase } from "../db/client";
import { ReviewRepository } from "../db/review-repository";
import { ImageService } from "../images/image-service";
import { MacOSKeychain } from "../settings/keychain";
import { SettingsRepository } from "../settings/settings-repository";
import { SettingsService } from "../settings/settings-service";
import { ReviewService } from "../services/review-service";
import { InMemoryReviewLock } from "../services/review-lock";
import { ReviewFileStore } from "../storage/review-file-store";
import { AuthRepository } from "../auth/auth-repository";
import { AuthService } from "../auth/auth-service";
import { RetentionService } from "../retention/retention-service";

export interface ApplicationServices {
  authService: AuthService;
  settingsService: SettingsService;
  reviewService: ReviewService;
  imageService: ImageService;
  pdfService: PdfService;
  retentionService: RetentionService;
}

function createApplicationServices(): ApplicationServices {
  const database = openAppDatabase();
  const settingsService = new SettingsService(
    new SettingsRepository(database.db),
    new MacOSKeychain(),
  );
  const reviewRepository = new ReviewRepository(database.db);
  const fileStore = new ReviewFileStore();
  const reviewLock = new InMemoryReviewLock();
  const authRepository = new AuthRepository(database.db);
  const retentionService = new RetentionService(reviewRepository, fileStore, {
    lock: reviewLock,
    audit: authRepository,
  });
  const aiReviewer = new OpenAIReviewAdapter(settingsService);
  return {
    authService: new AuthService(authRepository),
    settingsService,
    imageService: new ImageService(fileStore, reviewRepository, {
      lock: reviewLock,
    }),
    pdfService: new PdfService(reviewRepository, fileStore, undefined, {
      lock: reviewLock,
    }),
    reviewService: new ReviewService(reviewRepository, fileStore, aiReviewer, {
      lock: reviewLock,
      retention: retentionService,
    }),
    retentionService,
  };
}

const globalServices = globalThis as typeof globalThis & {
  __aiCompositionGraderServices?: ApplicationServices;
};

export function getApplicationServices(): ApplicationServices {
  globalServices.__aiCompositionGraderServices ??= createApplicationServices();
  return globalServices.__aiCompositionGraderServices;
}
