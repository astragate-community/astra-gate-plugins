// Factory: adapting the runtime context Claude Code sends (reminders, compaction, restored files, skills).
import { CHANGED_FILE_HEADER, COMPACT_ARTIFACT, COMPACT_FILE, COMPACT_HEADER, COMPACT_OPENING, COMPACT_READ, DEFERRED_TOOLS_OPENING, HOOK_CONTEXT, HOOK_NOTIFICATION, HOOK_OUTPUT, INVOKED_SKILLS_COMPAT, INVOKED_SKILLS_OPENING, INVOKED_SKILLS_REMINDER, READ_RESULT_HEADER, SYSTEM_ENV_CONTEXT, SYSTEM_ENV_UPDATE, SYSTEM_MODEL_CONTEXT, SYSTEM_MODEL_LINE, SYSTEM_MODEL_UPDATE, SYSTEM_SKILL_CONTEXT, SYSTEM_TOKEN_CONTEXT, SYSTEM_TOKEN_OPENING } from "./signatures.mjs"
import { configSkillCompat, environmentWording, modelWording, quotedToolText } from "./wording.mjs"
import { piSummary } from "./opening.mjs"

// Claude Code also sends the skill list alone as a system message: the
// entries only, no header, no <system-reminder> wrapper and no token tail,
// as text blocks or a string (#72). Only a system message that is such a
// list (it opens with an entry) changes, and in it only the known line.
export function bareSkills(text) {
  return text.startsWith("- ") ? configSkillCompat(text) : text
}

export function systemContext(text) {
  text = changedFileContext(text)
  text = announcedSkills(text)
  const restored = restoredContext(text)
  if (restored !== null) return restored
  if (SYSTEM_TOKEN_OPENING.test(text) || SYSTEM_SKILL_CONTEXT.test(text)) return announcedContext(text)
  if (HOOK_OUTPUT.test(text) || text.startsWith(DEFERRED_TOOLS_OPENING)) {
    const at = text.indexOf(HOOK_CONTEXT)
    return at < 0 ? text : text.slice(0, at + 1) + generatedContext(text.slice(at + 1))
  }
  return generatedContext(text)
}

// Runtime notifications can precede a skill update, so the message opening
// is not a reliable discriminator. Require a complete token-terminated
// bundle, an exact skill header and a bullet-list paragraph. Only the known
// built-in description changes; notifications and hook-owned output stay.
function announcedSkills(text) {
  if (!/(?:^|\n\n)<total_tokens>\d+ tokens left<\/total_tokens>$/.test(text)) return text
  const parts = text.split("\n\n")
  for (let i = 0; i + 1 < parts.length; i++) {
    if (HOOK_OUTPUT.test(parts[i])) break
    if (parts[i] !== "The following skills are available for use with the Skill tool:") continue
    const list = parts[i + 1]
    // Skill descriptions can contain continuation lines.
    if (!list.startsWith("- ")) continue
    parts[i + 1] = configSkillCompat(list)
  }
  return parts.join("\n\n")
}

// Claude Code also announces several reminders as one system turn, with
// token context and no system-reminder wrappers. Only known metadata
// paragraphs change; numbered file contents and the hook's own output stay.
function announcedContext(text, start = 1) {
  const parts = changedFileContext(text).split(/\n\n(?!\.\.\. \[)/)
  const open = "<system-reminder>\n", close = "\n</system-reminder>"
  let quoteChangedFiles = true
  for (let i = start; i < parts.length; i++) {
    const part = parts[i]
    const hook = part.replace(/^<system-reminder>\n/, "")
    if (HOOK_OUTPUT.test(hook)) break
    // Any hook owns its file snippets. Non-startup hooks do not stop the
    // existing adaptation of model/environment metadata that follows them.
    if (HOOK_NOTIFICATION.test(hook)) quoteChangedFiles = false
    // Invoked skills span several paragraphs. The refused text is the fixed
    // opening plus the complete IMPORTANT paragraph; skill bodies follow
    // until the next attachment this adapter already knows. A token marker
    // after the reminder is not required: Claude Code emits one after a tool
    // result or a user prompt, and the restored reminder usually sits among
    // other attachments. Keep skill text out of the paragraph adapter,
    // including on a second pass.
    if (part.startsWith(INVOKED_SKILLS_OPENING + " ") || part.startsWith(INVOKED_SKILLS_COMPAT + " ")) {
      const end = invokedSkillsEnd(parts, i)
      const wrapped = open + parts.slice(i, end).join("\n\n") + close
      if (invokedSkillsMatch(wrapped)) {
        parts.splice(i, end - i, invokedSkills(wrapped).slice(open.length, -close.length))
        continue
      }
    }
    const changedFile = quoteChangedFiles ? changedFileText(part) : null
    if (changedFile !== null) {
      parts[i] = changedFile
      continue
    }
    const result = part.indexOf("\n" + READ_RESULT_HEADER)
    const heading = result < 0 ? part : part.slice(0, result)
    const wrapped = open + heading + close
    const compacted = compactContext(wrapped, quoteChangedFiles)
    if (compacted !== wrapped) {
      parts[i] = compacted.slice(open.length, -close.length) + (result < 0 ? "" : "\n" + readResultText(part.slice(result + 1)))
    } else if (SYSTEM_ENV_CONTEXT.test(part + "\n")) {
      parts[i] = generatedContext(part + "\n").slice(0, -1)
    } else if (SYSTEM_MODEL_UPDATE.test(part)) {
      parts[i] = systemModelLine(part)
    } else if (parts[i - 1] === "The following skills are available for use with the Skill tool:") {
      parts[i] = configSkillCompat(part)
    }
  }
  return parts.join("\n\n")
}

// After /compact, Claude Code (2.1.280) sends the files it restores and the
// session's runtime context as one turn without reminder wrappers or an
// opening token marker: restored-file notes, Read calls and their results,
// the environment, the model line, token and date. Each fixed fragment is
// refused on its own (plugins#68). Require the generated restored-file
// opening and the generated environment paragraph, a token marker or a
// complete invoked-skills reminder before the first hook. When no file was
// restored, that complete skills reminder can itself open the turn. Each
// paragraph is adapted as in a token-prefixed bundle, the rest kept
// byte-for-byte. An adapted block no longer has its generated opening,
// so a second pass leaves it as it is.
function restoredContext(text) {
  const parts = text.split(/\n\n(?!\.\.\. \[)/)
  const result = parts[0].indexOf("\n" + READ_RESULT_HEADER)
  const opening = "<system-reminder>\n" + (result < 0 ? parts[0] : parts[0].slice(0, result)) + "\n</system-reminder>"
  const file = COMPACT_FILE.test(opening) || COMPACT_READ.test(opening)
  if (!file && !parts[0].startsWith(INVOKED_SKILLS_OPENING + " ")) return null
  if (file && compactContext(opening) === opening) return null
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (HOOK_NOTIFICATION.test(part.replace(/^<system-reminder>\n/, ""))) return null
    if (part.startsWith(INVOKED_SKILLS_OPENING + " ")) {
      const end = invokedSkillsEnd(parts, i)
      const wrapped = "<system-reminder>\n" + parts.slice(i, end).join("\n\n") + "\n</system-reminder>"
      if (invokedSkillsMatch(wrapped)) return announcedContext(text, 0)
      if (!file) return null
    }
    if (i > 0 && (SYSTEM_ENV_CONTEXT.test(part + "\n") || /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(part))) return announcedContext(text, 0)
  }
  return null
}

function generatedContext(text) {
  const environment = SYSTEM_ENV_CONTEXT.test(text)
  if (!environment && !((SYSTEM_MODEL_UPDATE.test(text) || SYSTEM_ENV_UPDATE.test(text)) && SYSTEM_TOKEN_CONTEXT.test(text))) return text
  let out = text.replace(SYSTEM_MODEL_CONTEXT, modelWording)
  if (!environment) return out
  out = environmentWording(out)
  const skillHeader = "\n\nThe following skills are available for use with the Skill tool:\n\n"
  const skills = out.indexOf(skillHeader)
  if (skills >= 0) {
    const start = skills + skillHeader.length - 1
    out = out.slice(0, start) + configSkillCompat(out.slice(start))
  }
  return out
}
export function systemModelLine(text) {
  return text.replace(SYSTEM_MODEL_LINE, modelWording)
}

// The next paragraph of a bundle that already belongs to another attachment.
// Skill text ends here, so a following Read, environment or hook stays its
// own paragraph. A skill body that merely quotes one of these stays inside.
function invokedSkillsBoundary(part) {
  if (SYSTEM_TOKEN_CONTEXT.test(part) || part.startsWith("<total_tokens>") || HOOK_NOTIFICATION.test(part)) return true
  if (part.startsWith("Called the Read tool with the following input: ")) return true
  if (part.startsWith("Note: ") && part.includes(" was read before the last conversation was summarized")) return true
  if (part.startsWith("Result of calling the Read tool:\n")) return true
  if (SYSTEM_ENV_CONTEXT.test(part + "\n") || SYSTEM_ENV_UPDATE.test(part + "\n")) return true
  if (SYSTEM_MODEL_UPDATE.test(part)) return true
  if (part === "The following skills are available for use with the Skill tool:") return true
  if (part.startsWith("Available agent types for the Agent tool:")) return true
  if (part.startsWith("# MCP Server Instructions")) return true
  if (CHANGED_FILE_HEADER.test(part)) return true
  return false
}
// where the invoked-skills paragraphs that start at parts[from] end
function invokedSkillsEnd(parts, from) {
  let end = from + 1
  while (end < parts.length && !invokedSkillsBoundary(parts[end])) end++
  return end
}
function invokedSkillsMatch(text) {
  const opening = "<system-reminder>\n" + INVOKED_SKILLS_COMPAT
  const generated = text.startsWith(opening) ? "<system-reminder>\n" + INVOKED_SKILLS_OPENING + text.slice(opening.length) : text
  return generated.match(INVOKED_SKILLS_REMINDER)
}
function invokedSkills(text) {
  const match = invokedSkillsMatch(text)
  if (!match) return text
  const quoted = quotedToolText(match[1], "Skill text encoded as a JSON string. Decode the JSON string to recover the exact original text before using it:\n")
  const head = text.slice(0, text.length - match[1].length - "\n</system-reminder>".length)
  return head.replace(INVOKED_SKILLS_OPENING, INVOKED_SKILLS_COMPAT) + quoted + "\n</system-reminder>"
}
export function compactContext(text, quoteChangedFiles = true) {
  // A translating gateway can fold an announced system turn into user text.
  if (SYSTEM_TOKEN_OPENING.test(text) || SYSTEM_SKILL_CONTEXT.test(text)) return announcedContext(text)
  if (HOOK_OUTPUT.test(text) || text.startsWith(DEFERRED_TOOLS_OPENING)) return systemContext(text)
  const restored = restoredContext(text)
  if (restored !== null) return restored
  const result = readResultText(text)
  if (result !== null) return result
  const changedFile = quoteChangedFiles && text.startsWith("<system-reminder>\n") ? changedFileText(text) : null
  if (changedFile !== null) return changedFile
  const prefix = text.match(COMPACT_ARTIFACT)?.[0] ?? ""
  if (text.startsWith(COMPACT_HEADER, prefix.length)) {
    const context = text.slice(prefix.length + COMPACT_HEADER.length)
    const header = prefix + COMPACT_HEADER.replace(COMPACT_OPENING, "Earlier conversation context is summarized below.")
    const quoted = quotedToolText(context, "Conversation context encoded as a JSON string. Decode the JSON string to recover the exact original context before continuing:\n")
    return header + (quoted === context ? context : "\n\n" + quoted)
  }
  const summary = piSummary(text)
  if (summary !== text) return summary
  const skills = invokedSkills(text)
  if (skills !== text) return skills
  const read = text.match(COMPACT_READ)
  if (read) {
    try {
      if (typeof JSON.parse(read[1])?.file_path === "string") return text.replace("Called the Read tool with the following input:", "Previously read file with these arguments:")
    } catch {}
  }
  const file = text.match(COMPACT_FILE)
  if (file) return "<system-reminder>\nPreviously read file: " + file[1] + ". Its contents were omitted from the conversation summary because of length. Use Read tool if you need to access it.\n</system-reminder>"
  return announcedSkills(text)
}

// Restored and @-attached reads are user text rather than tool_result blocks.
// Keep the generated header/wrapper; encode only the original file text.
function readResultText(text) {
  const wrapped = text.startsWith("<system-reminder>\n")
  const prefix = (wrapped ? "<system-reminder>\n" : "") + READ_RESULT_HEADER
  const suffix = wrapped ? "\n</system-reminder>" : ""
  if (!text.startsWith(prefix) || (suffix && !text.endsWith(suffix))) return null
  const content = text.slice(prefix.length, suffix ? -suffix.length : undefined)
  return prefix + quotedToolText(content) + suffix
}
function changedFileText(text) {
  const open = "<system-reminder>\n", close = "\n</system-reminder>"
  const wrapped = text.startsWith(open)
  if (wrapped && !text.endsWith(close)) return null
  const content = wrapped ? text.slice(open.length, -close.length) : text
  const header = content.match(CHANGED_FILE_HEADER)?.[0]
  if (!header) return null
  const lines = content.slice(header.length)
  if (!/^\d+[\t:][^\n]*(?:\n(?:\.\.\.\n)?\d+[\t:][^\n]*)*(?:(?:\n\.\.\.)?\n\n\.\.\. \[\d+ lines truncated\] \.\.\.)?$/.test(lines)) return null
  return (wrapped ? open : "") + header + quotedToolText(lines) + (wrapped ? close : "")
}

// System-turn notifications may start with the changed file, or put it
// among other notifications before the final token marker. Hook output is
// owned by the hook, even when it quotes a complete generated notification.
function changedFileContext(text) {
  // Keep even an incomplete truncation tail with its snippet, so the
  // complete-notification check can reject it rather than encode a fragment.
  const parts = text.split(/\n\n(?!\.\.\. \[)/)
  if (changedFileText(parts[0]) === null && !SYSTEM_TOKEN_OPENING.test(text) && !/(?:^|\n\n)<total_tokens>\d+ tokens left<\/total_tokens>$/.test(text)) return text
  for (let i = 0; i < parts.length; i++) {
    if (HOOK_NOTIFICATION.test(parts[i].replace(/^<system-reminder>\n/, ""))) break
    parts[i] = changedFileText(parts[i]) ?? parts[i]
  }
  return parts.join("\n\n")
}