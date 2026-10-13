// The streaming half of the tool guard: frames in, checked frames out, held-back chat tool calls released
// when their choice finishes.
import { chatBuffer } from "./chat-buffer.mjs"
import { framesFrom } from "./frames.mjs"
import { GuardError, failure, parseJSON } from "./guard-core.mjs"
import { endsStream, isFailureEvent } from "./sse.mjs"
import { checkSnapshots } from "./snapshots.mjs"

const encoder = new TextEncoder()

function encodeEvent(data, name = "") {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`
}

// the frame with its data lines replaced by the rewritten event
function rewrite(frame, data) {
  const lines = frame.lines.filter((line) => line !== "data" && !line.startsWith("data:"))
  lines.push(`data: ${JSON.stringify(data)}`)
  return `${lines.join("\n")}\n\n`
}

export function guardedStream(response, protocol, checkName) {
  const reader = response.body?.getReader()
  const chat = protocol === "chat" ? chatBuffer(checkName) : null
  let frames = reader ? framesFrom(reader) : null
  let completed = false
  let stopped = false
  let released = false
  let cancellation
  function release() {
    if (reader && !released) {
      reader.releaseLock()
      released = true
    }
    chat?.clear()
    frames = null
  }
  function cancel(reason) {
    cancellation ??= (async () => {
      try {
        await reader?.cancel(reason)
      } finally {
        release()
      }
    })()
    return cancellation
  }
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          while (!stopped) {
            const next = frames ? await frames.next() : { done: true }
            if (stopped) return
            if (next.done) {
              if (!completed || chat?.size) throw new GuardError("Upstream SSE ended without a completion marker")
              stopped = true
              release()
              controller.close()
              return
            }
            const frame = next.value
            if (frame.name !== "error" && !frame.text.trim()) {
              controller.enqueue(encoder.encode(frame.raw))
              return
            }
            if (frame.name !== "error" && frame.text.trim() === "[DONE]") {
              if (protocol !== "chat") throw new GuardError("Unexpected upstream completion marker")
              const final = chat.finish()
              completed = true
              controller.enqueue(encoder.encode((final ? encodeEvent(final) : "") + frame.raw))
              return
            }
            const data = frame.name === "error" ? null : parseJSON(frame.text)
            const type = data?.type ?? frame.name
            if (frame.name === "error" || isFailureEvent(data, type)) {
              stopped = true
              try {
                await cancel()
              } catch (cause) {
                controller.error(cause)
                return
              }
              controller.enqueue(encoder.encode(frame.raw))
              controller.close()
              return
            }
            let changed
            let result = data
            if (chat) {
              const checked = chat.apply(data)
              changed = checked.changed
              result = checked.data
            } else {
              changed = checkSnapshots(data, protocol, checkName)
            }
            if (endsStream(protocol, type)) completed = true
            if (result) {
              controller.enqueue(encoder.encode(changed ? rewrite(frame, result) : frame.raw))
              return
            }
          }
        } catch (error) {
          if (stopped) return
          stopped = true
          if (error instanceof GuardError) {
            try {
              await cancel(error)
            } catch (cause) {
              controller.error(cause)
              return
            }
            controller.enqueue(
              encoder.encode(encodeEvent(failure(protocol, error.message, true), protocol === "chat" ? "" : "error")),
            )
            controller.close()
          } else {
            release()
            controller.error(error)
          }
        }
      },
      async cancel(reason) {
        stopped = true
        await cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
