export interface CustomProviderConnectionMetadata {
  id: string;
  name: string;
  protocol: "openai-compatible" | "anthropic";
  endpoint: string;
  modelId: string;
  allowLocal: boolean;
  hasApiKey: boolean;
  credentialType: "api_key";
}

export interface CustomProviderSettingsSnapshot {
  mode: "live" | "demo";
  customConnections?: CustomProviderConnectionMetadata[];
}

export interface CustomProviderApi {
  (
    path: string,
    method?: string,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface CustomProviderUI {
  update(snapshot: CustomProviderSettingsSnapshot | null): void;
  reset(): void;
  setBusy(value: boolean): void;
  clearSecrets(): void;
}

export interface CustomProviderUICallbacks {
  refresh?: () => Promise<void> | void;
  setBusy?: (value: boolean) => void;
}

export declare function attachCustomProviderConnectionsUI(
  api: CustomProviderApi,
  callbacks?: CustomProviderUICallbacks,
): CustomProviderUI;
