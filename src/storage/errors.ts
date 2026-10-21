/**
 * Storage-layer error type. Lives in its own module so the database handle,
 * the repositories and the Storage facade can all raise it without an
 * import cycle.
 */
export class StorageError extends Error {
  constructor(readonly kind: "open" | "query" | "constraint" | "closed", message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export function storageErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
