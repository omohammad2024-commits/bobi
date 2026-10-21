/**
 * Interview topics (platform Phase 4/5) — the fixed topic ids the owner
 * interview fills, in question order (deduplicated).
 *
 * Leaf data module: this list used to be derived inside interview.ts
 * from INTERVIEW_QUESTIONS, while owner_profile.ts imported the value
 * back from interview.ts and interview.ts imported the OwnerProfile
 * type from owner_profile.ts — a cycle. The topics are pure data with
 * no dependencies, so they live here; interview.ts re-exports the list
 * (its public surface is unchanged) and owner_profile.ts imports it
 * from here. One direction only. Keep this list in sync with the
 * `topic` fields of INTERVIEW_QUESTIONS in interview.ts.
 */

/** Every interview topic id, in question order (deduplicated). */
export const INTERVIEW_TOPICS: readonly string[] = [
  "basics",
  "work_focus",
  "projects",
  "taste_preferences",
  "communication_style",
  "communication_donts",
  "people_details",
  "routines_schedule",
  "technical_facts",
  "standing_rules",
  "goals",
];
