/**
 * Memory provider selection (Phase D2).
 *
 * Reads BOBI_MEMORY_PROVIDER directly from the environment — deliberately
 * WITHOUT going through src/config/config.ts, so a new backend can be
 * selected without touching the config schema. Documented in .env.example.
 */
import type { Storage } from "../storage/storage";
import type { MemoryProvider } from "./provider";
import { SqliteMemoryProvider } from "./sqlite_provider";
import { getMemoryProvider, memoryProviderNames, registerMemoryProvider } from "./registry";

/** The provider used when BOBI_MEMORY_PROVIDER is unset or blank. */
export const DEFAULT_MEMORY_PROVIDER = "sqlite";

/**
 * Resolve the memory provider for this process.
 *
 * "sqlite" builds a fresh SqliteMemoryProvider over the given storage on
 * every call — no stale-storage caching across calls. Any other name must
 * have been registered (registerMemoryProvider); an unknown name throws
 * instead of silently falling back, because a misconfigured backend should
 * be loud at startup, not a quiet surprise later.
 */
export function resolveMemoryProvider(storage: Storage): MemoryProvider {
  const raw = process.env.BOBI_MEMORY_PROVIDER;
  const name = raw === undefined || raw.trim() === "" ? DEFAULT_MEMORY_PROVIDER : raw.trim();

  if (name === DEFAULT_MEMORY_PROVIDER) {
    const provider = new SqliteMemoryProvider(storage);
    // Idempotent: keeps registry.names() honest about the default being
    // available, without ever replacing a custom "sqlite" registration.
    if (getMemoryProvider(provider.name) === undefined) {
      registerMemoryProvider(provider);
    }
    return provider;
  }

  const custom = getMemoryProvider(name);
  if (custom === undefined) {
    throw new Error(
      `BOBI_MEMORY_PROVIDER="${name}" is not a registered memory provider ` +
        `(available: ${memoryProviderNames().join(", ") || "none"})`,
    );
  }
  return custom;
}
