// Rebuilding one Anthropic message from a stream's events: `apply(data, type)` takes each event, `finish()` returns the
// message (throwing on a stream that cannot be put together).
const sorted = (map) => [...map].sort(([a], [b]) => a - b).map(([, value]) => value);

function itemIndex(value) {
  const result = value ?? 0;
  if (!Number.isInteger(result) || result < 0 || result > 65535) throw new Error('Invalid stream item index');
  return result;
}

export function anthropicAccumulator() {
  let body = {
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: null,
    stop_sequence: null,
  }
  const blocks = new Map()
  const argumentsJSON = new Map()
  return {
    apply(data, type) {
      if (type === "message_start") {
        body = { ...body, ...data.message }
        for (const [position, block] of (data.message?.content ?? []).entries()) blocks.set(position, block)
      } else if (type === "content_block_start") {
        blocks.set(itemIndex(data.index), data.content_block)
      } else if (type === "content_block_delta") {
        const position = itemIndex(data.index)
        const block = blocks.get(position)
        if (!block) throw new Error("Content delta without a content block")
        const delta = data.delta ?? {}
        const field = {
          text_delta: "text",
          thinking_delta: "thinking",
          signature_delta: "signature",
        }[delta.type]
        if (field) block[field] = (block[field] ?? "") + (delta[field] ?? "")
        if (delta.type === "input_json_delta") {
          argumentsJSON.set(position, (argumentsJSON.get(position) ?? "") + (delta.partial_json ?? ""))
        }
      } else if (type === "message_delta") {
        Object.assign(body, data.delta)
        if (data.usage) body.usage = { ...body.usage, ...data.usage }
      }
    },
    finish() {
      for (const [position, value] of argumentsJSON) {
        try {
          blocks.get(position).input = JSON.parse(value)
        } catch {
          throw new Error("Invalid tool input JSON in upstream stream")
        }
      }
      body.content = sorted(blocks)
      return body
    },
  }
}

