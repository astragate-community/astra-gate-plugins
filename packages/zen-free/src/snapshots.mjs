// Checking (and renaming, in place) the tool calls in a whole reply or in a stream event that carries a snapshot.
import { GuardError, list, object } from "./guard-core.mjs"

function checkFunction(value, checkName) {
  if (!object(value)) throw new GuardError("Invalid upstream function call")
  const name = checkName(value.name)
  const changed = name !== value.name
  value.name = name
  return changed
}

/** A chat message's function_call / tool_calls; true when a name was renamed. */
export function checkChatMessage(message, checkName) {
  if (!object(message)) return false
  let changed = false
  if (message.function_call != null) changed = checkFunction(message.function_call, checkName)
  for (const call of list(message.tool_calls)) {
    if (!object(call) || (call.type != null && call.type !== "function")) {
      throw new GuardError("Unsupported upstream tool call")
    }
    changed = checkFunction(call.function, checkName) || changed
  }
  return changed
}

/** Every tool call in a reply body or event of the protocol; true when a name was renamed. */
export function checkSnapshots(data, protocol, checkName) {
  let changed = false
  if (protocol === "chat") {
    for (const choice of list(data.choices)) {
      if (!object(choice)) throw new GuardError("Invalid upstream choice")
      changed = checkChatMessage(choice.message, checkName) || changed
    }
    return changed
  }
  const stack = [data]
  while (stack.length) {
    const value = stack.pop()
    if (!object(value)) throw new GuardError("Invalid upstream tool snapshot")
    if (
      protocol === "responses" &&
      typeof value.type === "string" &&
      value.type.endsWith("_call") &&
      value.type !== "function_call"
    ) {
      throw new GuardError("Unsupported upstream tool call type")
    }
    if (
      (protocol === "responses" && value.type === "function_call") ||
      (protocol === "anthropic" && ["tool_use", "server_tool_use"].includes(value.type))
    ) {
      changed = checkFunction(value, checkName) || changed
    }
    const arrays = protocol === "responses" ? ["output", "content"] : ["content"]
    const objects = protocol === "responses" ? ["response", "item", "part"] : ["message", "content_block"]
    for (const key of arrays) {
      // Text content is not a snapshot container.
      if (typeof value[key] === "string") continue
      for (const item of list(value[key])) stack.push(item)
    }
    for (const key of objects) {
      if (value[key] != null) stack.push(value[key])
    }
  }
  return changed
}
