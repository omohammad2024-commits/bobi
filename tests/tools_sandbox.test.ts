/**
 * sandbox — the shared path-guard helper behind files, telegram_actions,
 * voice_tools and extract_document.
 *
 * Pins:
 *  - absolute paths refused (not_allowed)
 *  - `..` escapes refused lexically (not_allowed)
 *  - NUL bytes refused (invalid_input)
 *  - a missing file under mustExist is not_found with the caller's message
 *  - a symlink file inside the root pointing outside is refused
 *  - a symlink directory inside the root pointing outside is refused
 *  - a valid nested file resolves
 *  - mustExist:false resolves a not-yet-existing path under an existing dir
 *
 * Every test runs against fresh temp dirs; nothing touches the repo.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolError } from "../src/tools/errors";
import type { ToolErrorKind } from "../src/tools/errors";
import {
  ensureSandboxRoot,
  resolveSandboxPath,
} from "../src/tools/sandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Assert a rejection is a ToolError with the exact kind and message. */
async function expectToolError(
  promise: Promise<unknown>,
  kind: ToolErrorKind,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe(kind);
    expect((err as ToolError).message).toBe(message);
    return;
  }
  throw new Error(`expected ToolError(${kind}, "${message}") but the call resolved`);
}

describe("sandbox helper", () => {
  test("absolute path is refused", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    await expectToolError(
      resolveSandboxPath(root, "/etc/passwd", { mustExist: true }),
      "not_allowed",
      "That path is outside the files area.",
    );
  });

  test(".. escape is refused", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    await expectToolError(
      resolveSandboxPath(root, "../outside.txt", { mustExist: true }),
      "not_allowed",
      "That path is outside the files area.",
    );
    await expectToolError(
      resolveSandboxPath(root, "sub/../../outside.txt", { mustExist: true }),
      "not_allowed",
      "That path is outside the files area.",
    );
  });

  test("NUL byte is refused", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    await expectToolError(
      resolveSandboxPath(root, "bad\0name.txt", { mustExist: true }),
      "invalid_input",
      "That path isn't valid.",
    );
  });

  test("missing file is not_found with the caller's message", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    await expectToolError(
      resolveSandboxPath(root, "missing.txt", {
        mustExist: true,
        notFoundMessage: "That file doesn't exist.",
      }),
      "not_found",
      "That file doesn't exist.",
    );
    await expectToolError(
      resolveSandboxPath(root, "missing.txt", { mustExist: true }),
      "not_found",
      "That path doesn't exist.",
    );
  });

  test("symlink file inside the root pointing outside is refused", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    const outside = makeTempDir("bobi-sandbox-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(root, "link.txt"));
    await expectToolError(
      resolveSandboxPath(root, "link.txt", { mustExist: true }),
      "not_allowed",
      "That path is outside the files area.",
    );
  });

  test("symlink directory inside the root pointing outside is refused", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    const outside = makeTempDir("bobi-sandbox-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linkdir"), "dir");
    await expectToolError(
      resolveSandboxPath(root, "linkdir/secret.txt", { mustExist: true }),
      "not_allowed",
      "That path is outside the files area.",
    );
  });

  test("valid nested file resolves", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "sub", "deep", "note.txt"), "hello");
    const target = await resolveSandboxPath(root, "sub/deep/note.txt", {
      mustExist: true,
    });
    expect(target).toBe(resolve(root, "sub/deep/note.txt"));
  });

  test("mustExist:false resolves a not-yet-existing path under an existing dir", async () => {
    const root = await ensureSandboxRoot(makeTempDir("bobi-sandbox-root-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    const target = await resolveSandboxPath(root, "sub/new.txt", {
      mustExist: false,
    });
    expect(target).toBe(resolve(root, "sub/new.txt"));
  });
});
