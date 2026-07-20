import { OpenAIReviewAdapter } from "../ai/openai-review-adapter";
import { openAppDatabase } from "../db/client";
import { ReviewRepository } from "../db/review-repository";
import { ImageService } from "../images/image-service";
import { MacOSKeychain } from "../settings/keychain";
import { SettingsRepository } from "../settings/settings-repository";
import { SettingsService } from "../settings/settings-service";
import { ReviewService } from "../services/review-service";
import { InMemoryReviewLock } from "../services/review-lock";
import { ReviewFileStore } from "../storage/review-file-store";

export interface ApplicationServices {
  settingsService: SettingsService;
  reviewService: ReviewService;
  imageService: ImageService;
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
  const aiReviewer = new OpenAIReviewAdapter(settingsService);
  return {
    settingsService,
    imageService: new ImageService(fileStore, reviewRepository, {
      lock: reviewLock,
    }),
    reviewService: new ReviewService(reviewRepository, fileStore, aiReviewer, {
      lock: reviewLock,
    }),
  };
}

const globalServices = globalThis as typeof globalThis & {
  __aiCompositionGraderServices?: ApplicationServices;
};

export function getApplicationServices(): ApplicationServices {
  globalServices.__aiCompositionGraderServices ??= createApplicationServices();
  return globalServices.__aiCompositionGraderServices;
}
