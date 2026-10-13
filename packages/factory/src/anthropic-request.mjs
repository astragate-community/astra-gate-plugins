// Factory: an Anthropic Messages request (/api/llm/a) as droid would send it: its system opens with droid's line,
// and Claude Code's fixed client metadata, which Factory refuses, is reworded or quoted.
import { bodyText } from "./body.mjs"
import { bareSkills, compactContext, systemContext, systemModelLine } from "./context.mjs"
import { DROID_LINE, clientOpening } from "./opening.mjs"
import { rewrite, rewriteContent } from "./rewrite.mjs"
import { CLAUDE_IDENTITIES, ENV_REMINDER, GLOBAL_INSTRUCTIONS, HOOK_OUTPUT, INSTRUCTIONS_REMINDER, MODEL_REMINDER, SKILL_REMINDER, SYSTEM_ENV_CONTEXT } from "./signatures.mjs"
import { parseToolJSON } from "./tools.mjs"
import { configSkillCompat, environmentWording, modelWording, quotedToolText } from "./wording.mjs"

// The request's system, as an array of text blocks that opens with droid's line: true when it changed. `request`
// is changed in place.
function adaptSystem(request) {
  let changed = false
  const system = typeof request.system === "string" ? [{ type: "text", text: request.system }] : request.system ?? []
  if (typeof request.system === "string" && !request.system.startsWith(DROID_LINE)) changed = true
  const blocks = []
  for (const block of system) {
    if (block?.type === "text" && block.text.trim() === "") {
      changed = true
      continue
    }
    // Attribution is consumed here; Factory does not strip Anthropic's
    // billing block and requires the Droid identity to be first.
    if (block?.type === "text" && block.text?.startsWith("x-anthropic-billing-header: cc_version=")) {
      changed = true
      continue
    }
    if (block?.type === "text") {
      // The gateway may join the identity and instructions into one block.
      // Only the complete fixed first line is metadata; keep the rest.
      const identity = [...CLAUDE_IDENTITIES].find((line) => block.text === line || block.text.startsWith(line + "\n"))
      const text = identity ? DROID_LINE + block.text.slice(identity.length) : block.text
      const adapted = clientOpening(systemModelLine(text))
      if (adapted !== block.text) {
        block.text = adapted
        changed = true
      }
    }
    blocks.push(block)
  }
  const identity = blocks.findIndex((b) => b?.type === "text" && b.text.startsWith(DROID_LINE))
  if (identity < 0) {
    blocks.unshift({ type: "text", text: DROID_LINE })
    changed = true
  } else if (identity > 0) {
    blocks.unshift(...blocks.splice(identity, 1))
    changed = true
  }
  // Drop only duplicate identity-only blocks. A block that also contains
  // task instructions stays intact.
  for (let i = blocks.length - 1; i > 0; i--) {
    if (blocks[i]?.type === "text" && blocks[i].text === DROID_LINE) {
      blocks.splice(i, 1)
      changed = true
    }
  }
  if (changed) request.system = blocks
  return changed
}

// One text block of a user turn: true when it changed. The first rule that applies is the only one.
function adaptUserText(block) {
  if (rewrite(block, "text", compactContext)) return true
  const text = block.text
  if (text.startsWith(INSTRUCTIONS_REMINDER) && text.includes(GLOBAL_INSTRUCTIONS)) {
    block.text = text.replaceAll(GLOBAL_INSTRUCTIONS, "(global instructions)")
    return true
  }
  if (HOOK_OUTPUT.test(text) || SYSTEM_ENV_CONTEXT.test(text)) {
    // a system message folded into the user's turn on its way here
    return rewrite(block, "text", systemContext)
  }
  if (ENV_REMINDER.test(text)) {
    block.text = environmentWording(text)
    return true
  }
  if (MODEL_REMINDER.test(text)) {
    block.text = modelWording(text)
    return true
  }
  if (SKILL_REMINDER.test(text)) return rewrite(block, "text", configSkillCompat)
  return false
}

// The system-role text of a message in `messages`: system messages as they are sent beside the system field.
const systemText = (text) => bareSkills(clientOpening(systemContext(text)))

// One message of the request: true when it changed.
function adaptMessage(message) {
  // Claude Code 2.1.288 also sends the same context as an array of text
  // blocks (#658): each text block is adapted as the string would be,
  // the blocks' other fields and any other block left as they are.
  if (message?.role === "system") return rewriteContent(message, "content", systemText)
  if (message?.role !== "user") return false
  if (typeof message.content === "string") return rewrite(message, "content", compactContext)
  if (!Array.isArray(message.content)) return false
  let changed = false
  for (const block of message.content) {
    if (block?.type === "tool_result") {
      if (rewriteContent(block, "content", quotedToolText)) changed = true
      continue
    }
    if (block?.type !== "text" || typeof block.text !== "string") continue
    if (adaptUserText(block)) changed = true
  }
  return changed
}

/**
 * body with the request adapted for Factory; body itself, byte for byte, when it needs no change or can't be
 * read as an Anthropic request.
 */
export function anthropicBody(body) {
  let request
  try {
    request = parseToolJSON(bodyText(body) ?? "")
  } catch {
    return body
  }
  // As in droidBody, JSON round-tripping uses JavaScript Numbers: integer
  // tokens above 2^53 can lose precision when a body needs adapting. A
  // body that needs no changes is returned byte-for-byte instead.
  if (!request || !Array.isArray(request.messages)) return body
  if (request.system != null && typeof request.system !== "string" && !Array.isArray(request.system)) return body
  if (Array.isArray(request.system) && request.system.some((b) => b?.type === "text" && typeof b.text !== "string")) return body

  let changed = adaptSystem(request)
  for (const message of request.messages) {
    if (adaptMessage(message)) changed = true
  }
  // Factory's streaming route refuses context_management ("Extra inputs
  // are not permitted", #71) while its non-streaming route takes it. A
  // streamed request goes without it: the server then edits nothing out of
  // the context, and the client's own compaction still runs.
  if (request.stream === true && "context_management" in request) {
    delete request.context_management
    changed = true
  }
  return changed ? JSON.stringify(request) : body
}
