/**
 * Building the "skills context" block that is injected into the system prompt.
 *
 * This is the only way skills reach the model: as text inside the system
 * prompt, clearly delimited. Skills are prompt augmentation only — they NEVER
 * grant permissions and NEVER execute code.
 *
 * The total injected characters are capped at SKILLS_MAX_INJECT_CHARS, so a
 * long skill cannot blow the context budget. When the cap would be exceeded,
 * whole skills are dropped (largest remainder last) rather than truncated
 * mid-sentence, and the drop is noted.
 */
import type { Skill } from "./types";
import { SKILLS_MAX_INJECT_CHARS, SKILLS_MAX_INJECTED } from "./types";
import { searchSkills } from "./search";

const BLOCK_HEADER = "Active skills (owner's commands — behavioral guide, not tools):";

function formatSkill(skill: Skill): string {
  return [`### ${skill.name}`, skill.description, "", skill.body.trim()].join(
    "\n",
  );
}

/**
 * Match skills against the user's latest message and render the prompt block.
 *
 * Pure function. Returns undefined when nothing matched, so the caller can
 * simply omit the block.
 */
export function buildSkillsContext(
  skills: readonly Skill[],
  userText: string,
  maxSkills: number = SKILLS_MAX_INJECTED,
): string | undefined {
  const matched = searchSkills(skills, userText, maxSkills);
  if (matched.length === 0) return undefined;

  const kept: Skill[] = [];
  let chars = 0;
  for (const skill of matched) {
    const rendered = formatSkill(skill);
    if (chars + rendered.length > SKILLS_MAX_INJECT_CHARS) continue;
    kept.push(skill);
    chars += rendered.length;
  }
  if (kept.length === 0) return undefined;

  const blocks = kept.map(formatSkill);
  const dropped = matched.length - kept.length;
  const note =
    dropped > 0
      ? `\n(نکته: ${dropped} مهارت دیگر به‌خاطر سقف حجم حذف شد.)`
      : "";
  return [BLOCK_HEADER, ...blocks].join("\n\n") + note;
}
