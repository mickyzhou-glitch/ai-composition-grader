import type {
  SaveSettingsInput as RepositorySettingsInput,
  SettingsRepository,
  AiModelRole,
} from "./settings-repository";

export interface SecretStore {
  set(secret: string, role?: AiModelRole): Promise<void>;
  get(role?: AiModelRole): Promise<string | null>;
  delete(role?: AiModelRole): Promise<void>;
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

export type SettingsCandidateTester = (
  input: RuntimeSettings,
) => Promise<unknown>;

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

  async save(input: SaveSettingsInput, role: AiModelRole = "content"): Promise<SettingsView> {
    const normalized = this.normalizeInput(input);
    return this.enqueue(() => this.saveExclusive(normalized, role));
  }

  testCandidate(
    input: SaveSettingsInput,
    tester: SettingsCandidateTester,
    save: true,
    role?: AiModelRole,
  ): Promise<SettingsView>;
  testCandidate(
    input: SaveSettingsInput,
    tester: SettingsCandidateTester,
    save: false,
    role?: AiModelRole,
  ): Promise<void>;
  testCandidate(
    input: SaveSettingsInput,
    tester: SettingsCandidateTester,
    save: boolean,
    role?: AiModelRole,
  ): Promise<SettingsView | void>;
  async testCandidate(
    input: SaveSettingsInput,
    tester: SettingsCandidateTester,
    save: boolean,
    role: AiModelRole = "content",
  ): Promise<SettingsView | void> {
    const normalized = this.normalizeInput(input);
    return this.enqueue(async () => {
      const apiKey =
        normalized.apiKey === undefined
          ? await this.getRoleSecret(role)
          : normalized.apiKey;
      if (!apiKey) throw new TypeError("apiKey must be configured");
      await tester({
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        apiKey,
      });
      if (save) return this.saveExclusive(normalized, role);
    });
  }

  private normalizeInput(input: SaveSettingsInput): SaveSettingsInput {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = input.model.trim();
    if (model.length === 0) throw new TypeError("model must not be empty");
    if (input.apiKey !== null && input.apiKey !== undefined && input.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }
    return { ...input, baseUrl, model };
  }

  private async saveExclusive(input: SaveSettingsInput, role: AiModelRole): Promise<SettingsView> {
    let previousSecret: string | null | undefined;
    let secretMutationAttempted = false;
    if (input.apiKey !== undefined) {
      previousSecret = await this.getRoleSecret(role);
    }

    try {
      if (input.apiKey === null) {
        secretMutationAttempted = true;
        await this.deleteRoleSecret(role);
      } else if (input.apiKey !== undefined) {
        secretMutationAttempted = true;
        await this.setRoleSecret(input.apiKey, role);
      }
      this.repository.save({ baseUrl: input.baseUrl, model: input.model }, role);
    } catch (error) {
      if (secretMutationAttempted) {
        try {
          if (previousSecret === null) {
            await this.deleteRoleSecret(role);
          } else if (previousSecret !== undefined) {
            await this.setRoleSecret(previousSecret, role);
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
    return (await this.get(role)) as SettingsView;
  }

  async get(role: AiModelRole = "content"): Promise<SettingsView | null> {
    const settings = this.repository.get(role);
    if (!settings) return null;
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      keyConfigured: (await this.getRoleSecret(role)) !== null,
    };
  }

  async getSecret(role: AiModelRole = "content"): Promise<string | null> {
    return this.getRoleSecret(role);
  }

  async getRuntimeConfig(role: AiModelRole = "content"): Promise<RuntimeSettings | null> {
    return this.enqueue(async () => {
      const settings = this.repository.get(role);
      if (!settings) return null;
      const apiKey = await this.getRoleSecret(role);
      if (!apiKey) return null;
      return {
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey,
      };
    });
  }

  private getRoleSecret(role: AiModelRole): Promise<string | null> {
    return role === "content" ? this.secretStore.get() : this.secretStore.get(role);
  }

  private setRoleSecret(secret: string, role: AiModelRole): Promise<void> {
    return role === "content" ? this.secretStore.set(secret) : this.secretStore.set(secret, role);
  }

  private deleteRoleSecret(role: AiModelRole): Promise<void> {
    return role === "content" ? this.secretStore.delete() : this.secretStore.delete(role);
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
