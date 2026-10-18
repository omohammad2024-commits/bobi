/**
 * The `skills` tool — lists the loaded skill names and one-line descriptions.
 *
 * Discovery only: skill bodies are never returned through this tool, so the
 * model cannot pull a whole skill's text into the conversation on demand, and
 * running this tool performs no action at all. The actual skill content reaches
 * the model only through the prompt-injection path in `context.ts`.
 *
 * Like every tool, it declares a permission (`tools:skills`) checked by the
 * Executor; a skill being listed here grants it nothing.
 */
import type { Tool, ToolContext } from "../tools/types";
import type { SkillCache } from "./loader";

export const SKILLS_PERMISSION = "tools:skills";

export interface SkillsInput {
  /** Optional substring filter on name or description; empty lists everything. */
  query?: string;
}

export interface SkillsOutput {
  skills: Array<{ name: string; description: string }>;
}

export interface SkillsDeps {
  cache: SkillCache;
}

/**
 * Build the skills-listing tool over a SkillCache. The tool reads through the
 * cache, so a newly added skill file is listed without a restart.
 */
export function createSkillsTool(deps: SkillsDeps): Tool<SkillsInput, SkillsOutput> {
  return {
    name: "skills",
    description: "فهرست مهارت‌های بارگذاری‌شده (فقط نام و توضیح کوتاه).",
    enabled: true,
    permission: { requires: [SKILLS_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        query: {
          type: "string",
          description: "فیلتر اختیاری روی نام یا توضیح مهارت.",
          maxLength: 200,
        },
      },
    },

    async run(input: SkillsInput, _ctx: ToolContext): Promise<SkillsOutput> {
      const q = input.query?.trim().toLowerCase() ?? "";
      const all = deps.cache.skills();
      const filtered =
        q.length === 0
          ? all
          : all.filter(
              (s) =>
                s.name.toLowerCase().includes(q) ||
                s.description.toLowerCase().includes(q),
            );
      return {
        skills: filtered.map((s) => ({ name: s.name, description: s.description })),
      };
    },
  };
}
