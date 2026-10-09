/** The only Jev session state exposed to the renderer. Never includes a key. */
export interface JevSessionStatus {
  enabled: boolean;
  hasKey: boolean;
}

/** User-entered configuration held in main-process memory for this app session. */
export interface JevConfigurePatch {
  enabled?: boolean;
  apiKey?: string;
  clearKey?: boolean;
}
