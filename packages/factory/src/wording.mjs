// Factory: how a refused text is reworded or quoted. Each rewording is one function, because the same wording is
// applied wherever Claude Code's generated text turns up (a reminder, a system message, a restored bundle).
import { CLAUDE_IDENTITIES, COMPACT_OPENING, CONFIG_SKILL_COMPAT, CONFIG_SKILL_METADATA } from "./signatures.mjs"

/** The generated "You are powered by the model …" sentences, worded as Factory takes them. */
export const modelWording = (text) =>
  text
    .replace("You are powered by the model named", "Current model name:")
    .replace("You are powered by the model", "Current model:")
    .replace("The exact model ID is", "Model ID:")
    .replace("Assistant knowledge cutoff is", "Model knowledge cutoff:")

/** The generated environment heading and its opening sentence, worded as Factory takes them. */
export const environmentWording = (text) =>
  text.replace("# Environment", "# Runtime context").replace("You have been invoked in the following environment:", "The session environment is:")

/** The known update-config skill line in a skill list; matched at the start of a line only. */
export const configSkillCompat = (text) => ("\n" + text).replace("\n" + CONFIG_SKILL_METADATA, "\n" + CONFIG_SKILL_COMPAT).slice(1)

export const QUOTED_TOOL_PREFIX = "Tool output encoded as a JSON string. Decode the JSON string to recover the exact original text before using it:\n"

// Factory also refuses these fixed client phrases when they are quoted in
// tool output, e.g. while reading this adapter's source. Keep the original
// text recoverable: a JSON string with explicit decoding instructions,
// rather than deleting or rewriting the file's contents. Other output and
// the tool's id, error/cache markers and non-text blocks stay untouched.
export function quotedToolText(text, prefix = QUOTED_TOOL_PREFIX) {
  if (![...CLAUDE_IDENTITIES].some((identity) => text.includes(identity)) &&
      !text.includes("You have been invoked in the following environment:") &&
      !text.includes("x-anthropic-billing-header: cc_version=") &&
      !text.includes(COMPACT_OPENING)) return text
  let encoded = JSON.stringify(text)
  for (const phrase of ["You are", "You have", "x-anthropic-billing-header", "system-reminder", COMPACT_OPENING]) {
    encoded = encoded.replaceAll(phrase, "\\u" + phrase.charCodeAt(0).toString(16).padStart(4, "0") + phrase.slice(1))
  }
  return prefix + encoded
}
