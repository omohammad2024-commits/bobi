/**
 * Pluggable long-term memory backends (Phase D2).
 *
 * Import from here, not the individual modules:
 *   import { resolveMemoryProvider, registerMemoryProvider } from "./memory";
 */
export type { MemoryProvider, StoredMemory } from "./provider";
export { SqliteMemoryProvider } from "./sqlite_provider";
export {
  registerMemoryProvider,
  getMemoryProvider,
  memoryProviderNames,
} from "./registry";
export { resolveMemoryProvider, DEFAULT_MEMORY_PROVIDER } from "./factory";
