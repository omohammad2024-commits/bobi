/**
 * Structural guards on the SQL schema.
 *
 * The schema lives inside JavaScript template literals, which means a stray
 * backtick in a SQL COMMENT silently ends the string and breaks the file. That
 * mistake was made three times while this code was written, and each time it
 * surfaced only as a confusing "',' expected" parse error far from the cause.
 *
 * These assertions catch it at the source, before the parser has to.
 *
 * Phase 6: the schema is split into per-domain fragments
 * (`<DOMAIN>_SCHEMA` in src/storage/repos/*.ts); the Storage facade assembles
 * them. The guards below run over the assembled body, exactly as before, and
 * additionally assert every fragment is wired into the assembly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const STORAGE_SOURCE = readFileSync("src/storage/storage.ts", "utf8");

/** Fragment const names in the facade's assembly order. */
const FRAGMENTS: Array<{ name: string; file: string }> = [
  { name: "CONVERSATIONS_SCHEMA", file: "src/storage/repos/conversations.ts" },
  { name: "ACCESS_SCHEMA", file: "src/storage/repos/access.ts" },
  { name: "PROVIDERS_SCHEMA", file: "src/storage/repos/providers.ts" },
  { name: "USAGE_SCHEMA", file: "src/storage/repos/usage.ts" },
  { name: "SCHEDULING_SCHEMA", file: "src/storage/repos/scheduling.ts" },
  { name: "MEMORIES_SCHEMA", file: "src/storage/repos/memories.ts" },
  { name: "MISC_SCHEMA", file: "src/storage/repos/misc.ts" },
];

/** The body of one fragment's template literal, between its backticks. */
function fragmentBody(name: string, source: string): string {
  const marker = `export const ${name} = \``;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const open = start + marker.length;
  const close = source.indexOf("`;", open);
  expect(close).toBeGreaterThan(open);
  return source.slice(open, close);
}

/** The assembled SCHEMA body: every fragment's literal, in assembly order. */
function schemaBody(): string {
  return FRAGMENTS.map(({ name, file }) =>
    fragmentBody(name, readFileSync(file, "utf8")),
  ).join("");
}

describe("SQL schema source", () => {
  test("the schema literal contains no stray backtick", () => {
    // A backtick inside the body would have terminated the template early,
    // which is exactly the bug this guards.
    expect(schemaBody()).not.toContain("`");
  });

  test("the schema literal is not truncated", () => {
    // A truncated literal usually means the closing marker was found early.
    // Every table the storage layer depends on must be present.
    const body = schemaBody();
    for (const table of [
      "conversations",
      "messages",
      "audit_log",
      "group_access",
      "user_access",
      "memories",
      "reminders",
      "scheduled_tasks",
      "usage",
      "conversation_summaries",
      "search_settings",
      "search_credentials",
      "ai_providers",
      "ai_credential_pool",
      "user_prefs",
      "goals",
      "heartbeat_log",
    ]) {
      expect(body).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  test("the full-text index over messages is declared with its sync triggers", () => {
    // Phase D1: messages_fts is a VIRTUAL table (external-content FTS5), so
    // it is not in the CREATE TABLE list above — assert it separately, plus
    // the three triggers that keep it in sync inside the write transaction.
    const body = schemaBody();
    expect(body).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(");
    expect(body).toContain("tokenize='unicode61'");
    for (const trigger of [
      "messages_fts_insert",
      "messages_fts_delete",
      "messages_fts_update",
    ]) {
      expect(body).toContain(`CREATE TRIGGER IF NOT EXISTS ${trigger}`);
    }
  });

  test("no SQL comment inside the schema uses a backtick", () => {
    // Narrower than the whole-body check, and it names the offending line so a
    // future failure is obvious rather than mysterious.
    const offenders = schemaBody()
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.trim().startsWith("--") && line.includes("`"));
    expect(offenders).toEqual([]);
  });

  test("every fragment is wired into the facade SCHEMA assembly", () => {
    // A fragment that exists but is not assembled would silently drop its
    // tables on a fresh database — assert each name appears in the facade's
    // SCHEMA expression.
    const start = STORAGE_SOURCE.indexOf("const SCHEMA =");
    expect(start).toBeGreaterThan(-1);
    const end = STORAGE_SOURCE.indexOf(";", start);
    const assembly = STORAGE_SOURCE.slice(start, end);
    for (const { name } of FRAGMENTS) {
      expect(assembly).toContain(name);
    }
  });

  test("no fragment declares anything after its closing marker", () => {
    // Confirms each fragment's closing marker is the real end: whatever
    // follows it in the file must not continue SQL.
    for (const { name, file } of FRAGMENTS) {
      const source = readFileSync(file, "utf8");
      const marker = `export const ${name} = \``;
      const close = source.indexOf("`;", source.indexOf(marker) + 1);
      const after = source.slice(close + 2, close + 200).trim();
      expect(after).not.toMatch(/^--/);
    }
  });
});
