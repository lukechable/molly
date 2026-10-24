/**
 * Secret storage. Platform admin credentials and in-flight rotations ("stashes")
 * live in the OS keychain, never in the config file.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = 'molly';

export class KeychainStore implements SecretStore {
  private mod: Promise<typeof import('@napi-rs/keyring')> = import('@napi-rs/keyring');

  private async entry(key: string) {
    const { AsyncEntry } = await this.mod;
    return new AsyncEntry(SERVICE, key);
  }
  async get(key: string) {
    return (await this.entry(key)).getPassword();
  }
  async set(key: string, value: string) {
    await (await this.entry(key)).setPassword(value);
  }
  async delete(key: string) {
    await (await this.entry(key)).deletePassword();
  }
}

export class MemoryStore implements SecretStore {
  private data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

/** `openai:admin_key` -> `MOLLY_OPENAI_ADMIN_KEY`, so CI can inject credentials via env. */
export function envNameFor(key: string): string {
  return 'MOLLY_' + key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export const authKey = (platform: string, field: string) => `${platform}:${field}`;
export const stashKey = (credentialId: string) => `stash:${credentialId}`;
