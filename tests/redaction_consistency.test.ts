/**
 * Redactor consistency (P0-SEC-1).
 *
 * Three modules scrub secrets from text that leaves the process — the
 * structured logger (src/core/logger.ts), the audit log's detail scrubber
 * (src/auth/audit.ts), and the /debug bundle scrubber
 * (src/bot/cmd_system.ts). They are separate copies by design, so this file
 * pins them to the SAME behaviour on the shapes real call sites produce:
 *
 *  - a Telegram bot token inside its API URL form, `bot<token>` — the
 *    classic `\b\d+:` pattern misses it, because "bot" and the digits are
 *    both word characters, so there is no boundary to anchor on;
 *  - a Google/Gemini API key riding a `?key=` query parameter;
 *  - a Groq `gsk_…` key;
 *  - key=value text with a case-variant key name (`API_KEY=…`), and, for
 *    the logger, secret-named OBJECT fields in any casing.
 *
 * Benign text must pass through untouched in all three.
 */
import { describe, expect, test } from "bun:test";
import { Logger } from "../src/core/logger";
import { AuditLogger } from "../src/auth/audit";
import { scrubSecrets } from "../src/bot/cmd_system";

// Plausible-but-fake secrets, shaped exactly like the real ones.
const TG_TOKEN = `110201543:${"AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"}`;
const GEMINI_KEY = `AIza${"Sy"}${"A".repeat(33)}`;
const GROQ_KEY = `gsk_${"x".repeat(52)}`;
const KV_SECRET = "supersecretvalue123";

function viaLogger(text: string): string {
  const lines: string[] = [];
  const log = new Logger({ level: "debug", write: (l) => lines.push(l) });
  log.info(text);
  return (JSON.parse(lines[0]!) as { message: string }).message;
}

function viaLoggerFields(fields: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const log = new Logger({ level: "debug", write: (l) => lines.push(l) });
  log.info("m", fields);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function viaAudit(text: string): string {
  let detail = "";
  const audit = new AuditLogger({
    sink: (r) => {
      detail = r.detail ?? "";
    },
  });
  audit.record({ operation: "op", outcome: "success", detail: text });
  return detail;
}

const REDACTORS: ReadonlyArray<[string, (text: string) => string]> = [
  ["logger", viaLogger],
  ["audit", viaAudit],
  ["cmd_system", (t) => scrubSecrets(t)],
];

describe("redactors agree on the missed shapes (P0-SEC-1)", () => {
  const shapeCases: ReadonlyArray<[string, string, string]> = [
    // [case name, probe text, secret that must not survive]
    ["bot<token> URL", `GET https://api.telegram.org/bot${TG_TOKEN}/getMe`, TG_TOKEN],
    ["?key= Gemini key", `https://x.test/v1?key=${GEMINI_KEY}&y=1`, GEMINI_KEY],
    ["gsk_ key", `provider rejected key ${GROQ_KEY} today`, GROQ_KEY],
    ["API_KEY= value", `loaded API_KEY=${KV_SECRET} from env`, KV_SECRET],
  ];

  for (const [name, probe, secret] of shapeCases) {
    test(`all three redact: ${name}`, () => {
      for (const [label, redact] of REDACTORS) {
        const out = redact(probe);
        expect(out.includes(secret), `${label} leaked ${name}`).toBe(false);
        expect(out, `${label} did not mark ${name}`).toContain("[redacted]");
      }
    });
  }

  test("the three copies produce identical output on the shape probes", () => {
    const probes = [
      `GET https://api.telegram.org/bot${TG_TOKEN}/getMe`,
      `https://x.test/v1?key=${GEMINI_KEY}&y=1`,
      `provider rejected key ${GROQ_KEY} today`,
    ];
    for (const probe of probes) {
      const [a, b, c] = REDACTORS.map(([, redact]) => redact(probe));
      expect(a).toBe(b!);
      expect(b).toBe(c!);
    }
  });

  test("benign text is untouched by all three", () => {
    const benign =
      "the user pressed key: enter, order 123456 total, see https://example.com/page?a=1&b=2 for details";
    for (const [, redact] of REDACTORS) {
      expect(redact(benign)).toBe(benign);
    }
  });

  test("a bare Telegram token (existing shape) still redacts everywhere", () => {
    const probe = `token is ${TG_TOKEN} ok`;
    for (const [, redact] of REDACTORS) {
      expect(redact(probe).includes(TG_TOKEN)).toBe(false);
    }
  });
});

describe("logger secret-field names are case-insensitive (P0-SEC-1)", () => {
  test("API_KEY / ApiKey / TOKEN field values are redacted", () => {
    const out = viaLoggerFields({
      API_KEY: KV_SECRET,
      ApiKey: KV_SECRET,
      TOKEN: KV_SECRET,
      note: "harmless",
    });
    expect(out["API_KEY"]).toBe("[redacted]");
    expect(out["ApiKey"]).toBe("[redacted]");
    expect(out["TOKEN"]).toBe("[redacted]");
    expect(out["note"]).toBe("harmless");
  });
});
