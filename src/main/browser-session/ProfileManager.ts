export interface BrowserProfile {
  name: string;
  partition: string;
  persistent: boolean;
  createdAt: Date;
}

const DEFAULT_PROFILES: { name: string; persistent: boolean }[] = [
  { name: 'default', persistent: true },
  { name: 'login', persistent: true },
];

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
// RPC/MCP browser automation may only opt into profiles that are safe to
// mount without a separate profile-specific approval.
const SELECTABLE_RPC_PROFILES = new Set(['default']);

export function validateBrowserProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      'Browser profile names must be 1-64 characters and contain only letters, numbers, underscores, or hyphens',
    );
  }
  return name;
}

export function isSelectableBrowserProfile(name: string): boolean {
  return SELECTABLE_RPC_PROFILES.has(name);
}

/**
 * Manages browser profiles backed by Electron partition-based session isolation.
 * Each profile maps to a unique partition string for use in <webview> tags.
 */
export class ProfileManager {
  private profiles = new Map<string, BrowserProfile>();
  private activeProfileName: string;

  constructor() {
    for (const def of DEFAULT_PROFILES) {
      this.profiles.set(def.name, {
        name: def.name,
        partition: this.buildPartition(def.name, def.persistent),
        persistent: def.persistent,
        createdAt: new Date(),
      });
    }
    this.activeProfileName = 'default';
  }

  createProfile(name: string, persistent = true): BrowserProfile {
    const safeName = validateBrowserProfileName(name);
    if (this.profiles.has(safeName)) {
      throw new Error(`Profile "${safeName}" already exists`);
    }
    const profile: BrowserProfile = {
      name: safeName,
      partition: this.buildPartition(safeName, persistent),
      persistent,
      createdAt: new Date(),
    };
    this.profiles.set(safeName, profile);
    return profile;
  }

  getProfile(name: string): BrowserProfile | undefined {
    return this.profiles.get(name);
  }

  listProfiles(): BrowserProfile[] {
    return Array.from(this.profiles.values());
  }

  deleteProfile(name: string): boolean {
    if (DEFAULT_PROFILES.some((d) => d.name === name)) {
      return false;
    }
    return this.profiles.delete(name);
  }

  setActiveProfile(name: string): void {
    if (!this.profiles.has(name)) {
      throw new Error(`Profile "${name}" does not exist`);
    }
    this.activeProfileName = name;
  }

  getActiveProfile(): BrowserProfile {
    return this.profiles.get(this.activeProfileName)!;
  }

  getPartition(name?: string): string {
    const target = name ?? this.activeProfileName;
    const profile = this.profiles.get(target);
    if (!profile) {
      throw new Error(`Profile "${target}" does not exist`);
    }
    return profile.partition;
  }

  private buildPartition(name: string, persistent: boolean): string {
    const safeName = validateBrowserProfileName(name);
    return persistent ? `persist:wmux-${safeName}` : `wmux-${safeName}`;
  }
}
