// Rebuilding one JSON reply from a stream's events, one accumulator per wire protocol: `apply(data, type)` takes
// each event, `finish()` returns the reply (throwing on a stream that cannot be put together).
import { sorted } from "./sse.mjs"

function itemIndex(value) {
  const result = value ?? 0
  if (!Number.isInteger(result) || result < 0 || result > 65535) {
    throw new Error("Invalid stream item index")
  }
  return result
}

function appendFunction(target, delta) {
  for (const key of ["name", "arguments"]) {
    if (typeof delta[key] === "string") target[key] = (target[key] ?? "") + delta[key]
  }
}

function chatAccumulator() {
  const body = { object: "chat.completion", choices: [] }
  const choices = new Map()
  const tools = new Map()
  return {
    apply(data) {
      for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
        if (data[key] !== undefined) body[key] = data[key]
      }
      if (data.usage) body.usage = { ...body.usage, ...data.usage }
      for (const part of data.choices ?? []) {
        const position = itemIndex(part.index)
        if (!choices.has(position)) {
          choices.set(position, {
            index: position,
            message: { role: "assistant", content: null },
            finish_reason: null,
          })
          tools.set(position, new Map())
        }
        const choice = choices.get(position)
        const message = choice.message
        const delta = part.delta ?? {}
        if (delta.role) message.role = delta.role
        for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
          if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key]
        }
        if (delta.function_call) {
          message.function_call ??= { name: "", arguments: "" }
          appendFunction(message.function_call, delta.function_call)
        }
        for (const fragment of delta.tool_calls ?? []) {
          const toolIndex = itemIndex(fragment.index)
          const calls = tools.get(position)
          if (!calls.has(toolIndex)) calls.set(toolIndex, { type: "function", function: { name: "", arguments: "" } })
          const call = calls.get(toolIndex)
          for (const key of ["id", "type"]) {
            if (fragment[key] !== undefined) call[key] = fragment[key]
          }
          if (fragment.function) appendFunction(call.function, fragment.function)
        }
        if (part.finish_reason != null) choice.finish_reason = part.finish_reason
        if (part.logprobs) {
          choice.logprobs ??= {}
          for (const [key, value] of Object.entries(part.logprobs)) {
            if (Array.isArray(value)) choice.logprobs[key] = [...(choice.logprobs[key] ?? []), ...value]
            else choice.logprobs[key] = value
          }
        }
      }
    },
    finish() {
      for (const [position, choice] of choices) {
        if (tools.get(position).size) choice.message.tool_calls = sorted(tools.get(position))
      }
      body.choices = sorted(choices)
      return body
    },
  }
}

function responsesAccumulator() {
  let body = { object: "response", output: [] }
  let final
  const output = new Map()
  function item(data, type = "message") {
    let position = data.output_index
    if (position === undefined && data.item_id) {
      position = [...output].find(([, value]) => value.id === data.item_id)?.[0]
    }
    position = itemIndex(position)
    if (!output.has(position)) {
      const value = { type }
      if (data.item_id) value.id = data.item_id
      if (type === "message") Object.assign(value, { role: "assistant", content: [] })
      if (type === "function_call") value.arguments = ""
      if (type === "reasoning") value.summary = []
      output.set(position, value)
    }
    return output.get(position)
  }
  return {
    apply(data, type) {
      if (type === "response.created" || type === "response.in_progress") {
        if (data.response) {
          body = { ...body, ...data.response }
          for (const [position, value] of (data.response.output ?? []).entries()) output.set(position, value)
        }
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        if (data.item) output.set(itemIndex(data.output_index), data.item)
      } else if (type === "response.content_part.added" || type === "response.content_part.done") {
        const value = item(data)
        value.content ??= []
        value.content[itemIndex(data.content_index)] = data.part
      } else if (
        type === "response.output_text.delta" ||
        type === "response.output_text.done" ||
        type === "response.refusal.delta" ||
        type === "response.refusal.done"
      ) {
        const value = item(data)
        value.content ??= []
        const refusal = type.startsWith("response.refusal.")
        const field = refusal ? "refusal" : "text"
        const part = (value.content[itemIndex(data.content_index)] ??= refusal
          ? { type: "refusal", refusal: "" }
          : { type: "output_text", text: "", annotations: [] })
        if (type.endsWith(".delta")) part[field] = (part[field] ?? "") + (data.delta ?? "")
        else if (data[field] !== undefined) part[field] = data[field]
      } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
        const value = item(data, "function_call")
        if (type.endsWith(".delta")) value.arguments = (value.arguments ?? "") + (data.delta ?? "")
        else if (data.arguments !== undefined) value.arguments = data.arguments
      } else if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
        const value = item(data, "reasoning")
        value.summary ??= []
        value.summary[itemIndex(data.summary_index)] = data.part
      } else if (/^response\.reasoning_(summary_)?text\.(delta|done)$/.test(type)) {
        const value = item(data, "reasoning")
        const summary = type.includes("summary")
        const field = summary ? "summary" : "content"
        value[field] ??= []
        const part = (value[field][itemIndex(summary ? data.summary_index : data.content_index)] ??= {
          type: summary ? "summary_text" : "reasoning_text",
          text: "",
        })
        if (type.endsWith(".delta")) part.text += data.delta ?? ""
        else if (data.text !== undefined) part.text = data.text
      } else if (type === "response.reasoning_content.delta") {
        body.reasoning_content = (body.reasoning_content ?? "") + (data.delta ?? "")
      } else if (type === "response.completed" || type === "response.incomplete") {
        if (data.response && typeof data.response === "object") final = data.response
        body.status = type === "response.completed" ? "completed" : "incomplete"
        for (const key of ["incomplete_details", "finish_reason"]) {
          if (data[key] !== undefined) body[key] = data[key]
        }
      }
      if (data.usage) body.usage = { ...body.usage, ...data.usage }
    },
    finish() {
      if (final) return final
      body.output = sorted(output)
      return body
    },
  }
}

function anthropicAccumulator() {
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

const FACTORIES = {
  chat: chatAccumulator,
  responses: responsesAccumulator,
  anthropic: anthropicAccumulator,
}

/** A fresh accumulator for a protocol; throws for one Zen does not speak. */
export function accumulatorFor(protocol) {
  if (!Object.hasOwn(FACTORIES, protocol)) throw new TypeError(`Unsupported protocol: ${protocol}`)
  return FACTORIES[protocol]()
}
