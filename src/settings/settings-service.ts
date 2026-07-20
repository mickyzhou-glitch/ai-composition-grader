import type {
  SaveSettingsInput as RepositorySettingsInput,
  SettingsRepository,
} from "./settings-repository";

export interface SecretStore {
  set(secret: string): Promise<void>;
  get(): Promise<string | null>;
  delete(): Promise<void>;
}

export interface SaveSettingsInput extends RepositorySettingsInput {
  /** undefined preserves the existing key; null deletes it. */
  apiKey?: string | null;
}

export interface SettingsView {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
}

export interface RuntimeSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError("baseUrl must be a valid absolute HTTP(S) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "baseUrl must not contain credentials, a query string, or a fragment",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export class SettingsService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: SettingsRepository,
    private readonly secretStore: SecretStore,
  ) {}

  async save(input: SaveSettingsInput): Promise<SettingsView> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = input.model.trim();
    if (model.length === 0) throw new TypeError("model must not be empty");
    if (input.apiKey !== null && input.apiKey !== undefined && input.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }

    const normalized = { ...input, baseUrl, model };
    return this.enqueue(() => this.saveExclusive(normalized));
  }

  private async saveExclusive(input: SaveSettingsInput): Promise<SettingsView> {
    let previousSecret: string | null | undefined;
    let secretMutationAttempted = false;
    if (input.apiKey !== undefined) {
      previousSecret = await this.secretStore.get();
    }

    try {
      if (input.apiKey === null) {
        secretMutationAttempted = true;
        await this.secretStore.delete();
      } else if (input.apiKey !== undefined) {
        secretMutationAttempted = true;
        await this.secretStore.set(input.apiKey);
      }
      this.repository.save({ baseUrl: input.baseUrl, model: input.model });
    } catch (error) {
      if (secretMutationAttempted) {
        try {
          if (previousSecret === null) {
            await this.secretStore.delete();
          } else if (previousSecret !== undefined) {
            await this.secretStore.set(previousSecret);
          }
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            "Settings save failed and the prior Keychain secret could not be restored",
          );
        }
      }
      throw error;
    }
    return (await this.get()) as SettingsView;
  }

  async get(): Promise<SettingsView | null> {
    const settings = this.repository.get();
    if (!settings) return null;
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      keyConfigured: (await this.secretStore.get()) !== null,
    };
  }

  async getSecret(): Promise<string | null> {
    return this.secretStore.get();
  }

  async getRuntimeConfig(): Promise<RuntimeSettings | null> {
    return this.enqueue(async () => {
      const settings = this.repository.get();
      if (!settings) return null;
      const apiKey = await this.secretStore.get();
      if (!apiKey) return null;
      return {
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey,
      };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
