// Chat Completions streams a tool call in fragments; the guard holds them back until the choice finishes, so a
// call is only shown to the client once its whole name is known and checked.
import { MAX_BYTES } from "./constants.mjs"
import { GuardError, appendFunction, list, object, position } from "./guard-core.mjs"
import { sorted } from "./sse.mjs"
import { checkChatMessage, checkSnapshots } from "./snapshots.mjs"

const encoder = new TextEncoder()

export function chatBuffer(checkName) {
  const pending = new Map()
  let bytes = 0
  function charge(state, value) {
    const size = encoder.encode(JSON.stringify(value)).byteLength
    bytes += size
    state.bytes += size
    if (bytes > MAX_BYTES) throw new GuardError("Pending upstream tools exceed the 32 MiB buffer limit")
  }
  function stateFor(index, data) {
    if (!pending.has(index)) {
      const metadata = {}
      for (const key of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
        if (data[key] !== undefined) metadata[key] = data[key]
      }
      const state = { calls: new Map(), legacy: null, metadata, bytes: 0 }
      pending.set(index, state)
      charge(state, metadata)
    }
    return pending.get(index)
  }
  function complete(state) {
    const delta = {}
    if (state.calls.size) delta.tool_calls = sorted(state.calls)
    if (state.legacy) delta.function_call = state.legacy
    checkChatMessage(delta, checkName)
    return delta
  }
  function remove(index) {
    const state = pending.get(index)
    if (state) bytes -= state.bytes
    pending.delete(index)
  }
  return {
    get size() {
      return pending.size
    },
    clear() {
      pending.clear()
      bytes = 0
    },
    /** Takes one event: tool fragments are held back, finished choices get their checked calls. */
    apply(data) {
      let changed = checkSnapshots(data, "chat", checkName)
      const choices = list(data.choices)
      for (const choice of choices) {
        const delta = choice.delta
        if (!object(delta)) continue
        if (delta.tool_calls == null && delta.function_call == null) continue
        changed = true
        const state = stateFor(position(choice.index), data)
        for (const fragment of list(delta.tool_calls)) {
          if (!object(fragment) || (fragment.type != null && fragment.type !== "function")) {
            throw new GuardError("Unsupported upstream tool delta")
          }
          charge(state, fragment)
          const index = position(fragment.index)
          const previous = state.calls.get(index) ?? { index, function: {} }
          const value = { ...previous, ...fragment, index, function: previous.function }
          if (fragment.function != null) appendFunction(value.function, fragment.function)
          state.calls.set(index, value)
        }
        if (delta.function_call != null) {
          charge(state, delta.function_call)
          state.legacy ??= {}
          appendFunction(state.legacy, delta.function_call)
        }
        delete delta.tool_calls
        delete delta.function_call
      }
      // Validate every finishing choice before publishing any part of this event.
      for (const choice of choices) {
        if (choice.finish_reason == null) continue
        const index = position(choice.index)
        const state = pending.get(index)
        if (!state) continue
        choice.delta = { ...choice.delta, ...complete(state) }
        remove(index)
        changed = true
      }
      if (!changed) return { data, changed: false }
      data.choices = choices.filter(
        (choice) =>
          choice.finish_reason != null ||
          Object.keys(choice.delta ?? {}).length ||
          Object.keys(choice).some((key) => !["index", "delta", "finish_reason"].includes(key)),
      )
      return { data: data.choices.length || data.usage != null ? data : null, changed: true }
    },
    /** At `[DONE]`: one last event with the calls still held back, or null when none are. */
    finish() {
      if (!pending.size) return null
      const choices = [...pending]
        .sort(([a], [b]) => a - b)
        .map(([index, state]) => ({ index, delta: complete(state), finish_reason: null }))
      const metadata = pending.values().next().value.metadata
      pending.clear()
      bytes = 0
      return { ...metadata, choices }
    },
  }
}
