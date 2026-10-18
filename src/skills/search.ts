/**
 * Ranking skills against a piece of user text.
 *
 * Pure function: scoring only, no I/O. Matching is a simple keyword scheme —
 * an exact name hit beats a trigger hit beats a description/body hit — with a
 * deterministic tiebreak on name. Case-insensitive; Persian text is matched
 * as-is (no normalization beyond case folding, which is a no-op for Persian
 * script), so Persian queries match Persian descriptions and triggers.
 *
 * Scores are internal ranking weights only, not probabilities.
 */
import type { Skill } from "./types";
import { SKILLS_MAX_INJECTED } from "./types";

const SCORE_NAME_HIT = 100;
const SCORE_TRIGGER_HIT = 40;
const SCORE_DESCRIPTION_HIT = 20;
const SCORE_BODY_HIT = 10;

/**
 * Split a query into matchable tokens. Persian and Latin words survive as-is;
 * common Telegram noise (punctuation, slashes, bot commands) is stripped.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[«»"'.:;,!?؟،؛\/\\@#*_~`^()\[\]{}<>|=+]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Rank skills against the query text. Returns at most `limit` skills with a
 * positive score, best first, ties broken by name for determinism.
 */
export function searchSkills(
  skills: readonly Skill[],
  query: string,
  limit: number = SKILLS_MAX_INJECTED,
): Skill[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 || limit <= 0) return [];

  const scored: Array<{ skill: Skill; score: number }> = [];
  for (const skill of skills) {
    const score = scoreSkill(skill, tokens);
    if (score > 0) scored.push({ skill, score });
  }
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.skill.name < b.skill.name
        ? -1
        : a.skill.name > b.skill.name
          ? 1
          : 0,
  );
  return scored.slice(0, limit).map((s) => s.skill);
}

function scoreSkill(skill: Skill, tokens: string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const body = skill.body.toLowerCase();
  const triggers = skill.triggers.map((t) => t.toLowerCase());
  let score = 0;
  for (const token of tokens) {
    if (token.length < 2 && tokens.length > 1) continue; // one-char noise
    if (name.includes(token)) score += SCORE_NAME_HIT;
    if (triggers.some((t) => t.includes(token) || token.includes(t))) {
      score += SCORE_TRIGGER_HIT;
    }
    if (description.includes(token)) score += SCORE_DESCRIPTION_HIT;
    if (body.includes(token)) score += SCORE_BODY_HIT;
  }
  return score;
}
