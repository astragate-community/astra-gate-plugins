// Factory: unwrapping the arguments of a wrapped tool (tools.mjs) in the model's reply, JSON or event stream.
import { argument, isObject, parseToolJSON } from "./tools.mjs"

function unwrapped(input, name) {
  if (!isObject(input) || !Object.hasOwn(input, argument) || Object.keys(input).length !== 1) throw new Error(`Factory: tool ${name} returned invalid wrapped arguments`)
  return input[argument]
}

function responseHeaders(res) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return { status: res.status, statusText: res.statusText, headers }
}

function toolStream(body, names) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const blocks = new Map()
  let pending = "", ended = false
  const incomplete = () => {
    if (blocks.size) throw new Error("Factory: incomplete wrapped tool arguments")
  }
  const frame = (raw, ending) => {
    const lines = raw.split(/\r\n|\n|\r/)
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
    if (!data) return [raw + ending]
    if (data === "[DONE]") { incomplete(); return [raw + ending] }
    const event = parseToolJSON(data)
    const replace = (value) => {
      let first = true
      const next = []
      for (const line of lines) {
        if (!line.startsWith("data:")) next.push(line)
        else if (first) { next.push("data: " + JSON.stringify(value)); first = false }
      }
      return next.join(raw.includes("\r\n") ? "\r\n" : "\n") + ending
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && names.has(event.content_block.name)) {
      if (blocks.has(event.index)) throw new Error("Factory: duplicate wrapped tool block")
      blocks.set(event.index, { name: event.content_block.name, json: "", initial: event.content_block.input })
      event.content_block.input = {}
      return [replace(event)]
    }
    const block = blocks.get(event.index)
    if (block && event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      if (typeof event.delta.partial_json !== "string") throw new Error("Factory: invalid tool argument delta")
      block.json += event.delta.partial_json
      return []
    }
    if (block && event.type === "content_block_stop") {
      const input = unwrapped(block.json ? parseToolJSON(block.json) : block.initial, block.name)
      blocks.delete(event.index)
      const delta = { type: "content_block_delta", index: event.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }
      return ["event: content_block_delta\ndata: " + JSON.stringify(delta) + "\n\n", raw + ending]
    }
    if (event.type === "error") blocks.clear() // preserve the upstream error
    if (event.type === "message_stop") incomplete()
    return [raw + ending]
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(pending)
          if (boundary || (ended && pending)) {
            const raw = boundary ? pending.slice(0, boundary.index) : pending
            const ending = boundary?.[0] ?? ""
            pending = boundary ? pending.slice(boundary.index + ending.length) : ""
            const out = frame(raw, ending)
            for (const value of out) controller.enqueue(encoder.encode(value))
            if (out.length) return
            continue
          }
          if (ended) { incomplete(); controller.close(); return }
          const chunk = await reader.read()
          pending += decoder.decode(chunk.value, { stream: !chunk.done })
          ended = chunk.done
        }
      } catch (e) {
        controller.error(e)
        await reader.cancel(e).catch(() => {})
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

/** res with the wrapped tools' arguments unwrapped; res itself when there is nothing to do. */
export async function unwrapAnthropicTools(res, names) {
  if (!names.size || !res.ok || !res.body) return res
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) return new Response(toolStream(res.body, names), responseHeaders(res))
  if (!type.includes("json")) return res
  const text = await res.text()
  const message = parseToolJSON(text)
  let changed = false
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== "tool_use" || !names.has(block.name)) continue
    block.input = unwrapped(block.input, block.name)
    changed = true
  }
  return new Response(changed ? JSON.stringify(message) : text, responseHeaders(res))
}
