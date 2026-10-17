export const APP_NAME = "SOL";
export const APP_VERSION = "0.0.1";

/** Returns a human-readable status line for the running foundation. */
export function bootstrapMessage(): string {
  return `${APP_NAME} foundation ready`;
}
