/**
 * English language pack (D5).
 *
 * Covers exactly the same keys as the Persian pack — no empty strings, no
 * missing keys. Natural translations, not word-for-word: button labels stay
 * short, confirmations stay terse.
 */
import type { LanguagePack } from "./types";

export const en: LanguagePack = {
  // ---- main menu ----
  "menu.label.chat": "Chat",
  "menu.label.tools": "Tools",
  "menu.label.about": "About BOBI",
  "menu.reply.chat": "Chat: you'll soon be able to talk to BOBI.",
  "menu.reply.tools": "Tools: the tool list will be added in the next step.",
  "menu.reply.about": "BOBI — the all-purpose agent bot. Beta version.",
  "menu.reply.unknown": "Unknown option.",
  "menu.tool.calculator": "Calculator",
  "menu.tool.date_time": "Date & time",
  "menu.tool.text_utilities": "Text utilities",
  "menu.tool.unit_converter": "Unit converter",
  "menu.tool.fetch_url": "Web page reader",
  "menu.tool.web_search": "Web search",
  "menu.tools.title": "BOBI's active tools:",
  "menu.tools.empty": "Tools: there are no active tools.",
  "menu.tools.note":
    "The list above means the tools are available; running each one depends on your permission.",
  "menu.tools.item": "{index}. {label}",

  // ---- /start ----
  "start.greeting": "Hi! I'm BOBI. Pick an option:",

  // ---- /help ----
  "help.title": "Available commands:",
  "help.entry": "/{name} — {description}",
  "help.cmd.start": "Start and show the main menu",
  "help.cmd.help": "Command reference",
  "help.cmd.personality": "Show or change the reply tone",
  "help.cmd.voice": "Turn voice replies on/off",
  "help.cmd.lang": "Change the interface language",
  "help.cmd.compress": "Immediately summarize old conversations",
  "help.cmd.reset": "Clear this conversation's history",
  "help.cmd.stop": "Stop the running reply",
  "help.cmd.admin": "Bot admin panel",
  "help.cmd.ai": "Manage the AI provider",

  // ---- /voice ----
  "voice.not_configured":
    "Text-to-speech is not configured; voice mode is unavailable.",
  "voice.enabled":
    "Voice mode is on 🎙️ From now on I'll send replies as voice messages.",
  "voice.disabled": "Voice mode is off; replies will be sent as text again.",
  "voice.tts_failed": "Text-to-speech failed; sending the reply as text.",
  "voice.truncated": "The reply was long; continuing as text:",

  // ---- shared preference write failure (/voice, /personality) ----
  "prefs.save_failed": "Couldn't save the setting; try again.",

  // ---- /personality ----
  "personality.unavailable": "Changing personality is unavailable.",
  "personality.current_title": "Current reply personality:",
  "personality.list_item": "• {name} — {label}: {description}{mark}",
  "personality.current_mark": " ← current",
  "personality.usage": "To change: /personality <name>",
  "personality.unknown": "Unknown personality «{name}». Options: {options}",
  "personality.changed": "Reply personality changed to «{label}».",

  // ---- /reset ----
  "reset.done": "This conversation's history was cleared. 🧹",

  // ---- /compress ----
  "compress.compressed":
    "Summarization done ✅ Old conversations were compressed and their summaries kept.",
  "compress.nothing": "Not enough messages have accumulated for summarization yet.",
  "compress.failed": "Summarization failed; try again later.",
  "compress.unavailable": "Summarization is not active in this mode.",

  // ---- /stop ----
  "stop.nothing": "Nothing was running.",
  "stop.done": "Stopped ✅",

  // ---- /lang ----
  "lang.prompt": "Choose your interface language:",
  "lang.label.fa": "فارسی",
  "lang.label.en": "English",
  "lang.changed": "Language changed to «{label}» ✅",
  "lang.unknown": "Unknown language option.",
  "lang.unavailable": "Changing the language is unavailable.",

  // ---- gates ----
  "gate.group_not_ready":
    "This bot is not active in this group yet. The bot owner must approve access first.",
  "help.cmd.history": "Show conversation history",
  "help.cmd.save": "Export the conversation to a file",
  "help.cmd.retry": "Retry the last message",
  "help.cmd.undo": "Undo the last turns",
  "help.cmd.title": "Set the conversation title",
  "help.cmd.branch": "Branch the conversation",
  "help.cmd.resume": "Resume a past session",
  "help.cmd.sessions": "List past sessions",
  "help.cmd.status": "Session status",
  "help.cmd.context": "Context window status",
  "help.cmd.busy": "Busy-behavior preference",
  "help.cmd.whoami": "Show my role",
  "help.cmd.footer": "Technical footer preference",
  "help.cmd.version": "Show the BOBI version",
  "help.cmd.new": "Start a fresh session",
  "help.cmd.bg": "Run a prompt in the background",
  "help.cmd.btw": "Side question in a separate thread",
  "help.cmd.queue": "Queue a prompt",
  "help.cmd.steer": "Inject guidance into the turn",
  "help.cmd.agents": "List active agents and tasks",
  "help.cmd.suggestions": "Suggested automations",
  "help.cmd.blueprint": "Automation from a blueprint",
  "help.cmd.refine": "Extract lessons from the conversation",
  "help.cmd.review": "Independent review by a subagent",
  "help.cmd.plan": "Step-by-step plan, no execution",
  "help.cmd.moa": "Multi-model consultation",
  "help.cmd.memory": "Manage long-term memory",
  "help.cmd.bundles": "Skill bundles",
  "help.cmd.snapshot": "Backup / restore bot state",
  "help.cmd.restart": "Restart the bot",
  "help.cmd.update": "Update BOBI from git",
  "help.cmd.debug": "Debug report",
  "help.cmd.usage": "Token usage",
  "help.cmd.insights": "Usage insights",
  "help.cmd.model": "Switch the active model",
  "help.cmd.reasoning": "Reasoning effort level",
  "help.cmd.autoprune": "Auto-prune sessions",
  "help.cmd.tools": "Manage tools",
  "help.cmd.skills": "Manage skills",
  "help.cmd.curator": "Memory curator",
  "help.cmd.plugins": "Plugins",
  "help.cmd.reload_mcp": "Reload MCP servers",
  "help.cmd.reload_skills": "Rescan skills",
  "help.cmd.approve": "Approve a join request",
  "help.cmd.deny": "Reject a join request",
  "help.cmd.sethome": "Set the home chat",
  "help.cmd.pause": "Emergency pause",
  "help.cmd.goal": "Manage persistent goals",
  "help.cmd.subgoal": "Manage subgoals",
  "help.cmd.heartbeat": "Periodic heartbeat reminder",
  "help.cmd.loop": "Repeating task loop",
  "help.cmd.cron": "Scheduled tasks",
  "help.cmd.learn": "Draft a new skill",
};
