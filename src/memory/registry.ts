/**
 * Memory provider registry (Phase D2).
 *
 * Deliberately tiny: a name → provider map with no lifecycle, no ordering,
 * and no config parsing. Selection lives in factory.ts; this module only
 * remembers what was registered.
 *
 * Registration is process-global on purpose — a custom provider registers
 * once at startup (next to the other boot wiring), and every later
 * resolveMemoryProvider call sees it. Tests register throwaway providers and
 * never touch the production one.
 */
import type { MemoryProvider } from "./provider";

const providers = new Map<string, MemoryProvider>();

/** Register a provider under its own name. Re-registering replaces. */
export function registerMemoryProvider(provider: MemoryProvider): void {
  providers.set(provider.name, provider);
}

/** The provider registered under `name`, or undefined. */
export function getMemoryProvider(name: string): MemoryProvider | undefined {
  return providers.get(name);
}

/** Names of all registered providers. */
export function memoryProviderNames(): string[] {
  return [...providers.keys()];
}
