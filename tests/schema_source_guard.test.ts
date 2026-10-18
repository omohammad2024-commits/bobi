/**
 * Structural guards on the SQL schema.
 *
 * The schema lives inside a JavaScript template literal, which means a stray
 * backtick in a SQL COMMENT silently ends the string and breaks the file. That
 * mistake was made three times while this code was written, and each time it
 * surfaced only as a confusing "',' expected" parse error far from the cause.
 *
 * These assertions catch it at the source, before the parser has to.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/storage/storage.ts", "utf8");

/** The body of the SCHEMA template literal, between its opening and closing backticks. */
function schemaBody(): string {
  const start = SOURCE.indexOf("const SCHEMA = `");
  expect(start).toBeGreaterThan(-1);
  const open = start + "const SCHEMA = `".length;
  const close = SOURCE.indexOf("`;", open);
  expect(close).toBeGreaterThan(open);
  return SOURCE.slice(open, close);
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
      "usage",
      "conversation_summaries",
      "search_settings",
      "search_credentials",
      "ai_providers",
    ]) {
      expect(body).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
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

  test("the schema declares nothing after its closing marker", () => {
    // Confirms the closing marker found in schemaBody() is the real end: the
    // next non-empty line should start a new statement, not continue SQL.
    const close = SOURCE.indexOf("`;", SOURCE.indexOf("const SCHEMA = `") + 1);
    const after = SOURCE.slice(close + 2, close + 200).trim();
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toMatch(/^--/);
  });
});
