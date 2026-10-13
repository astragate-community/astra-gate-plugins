// Trae: reading its SSE answer — the events as {event, data}, with a name each can be told by.

// sse reads Trae's events: {event, data} for each, data parsed when JSON
export async function* sse(stream) {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = function* () {
    if (!data.length) return
    const raw = data.join("\n")
    data = []
    let v = raw
    try {
      v = JSON.parse(raw)
    } catch {}
    yield { event: event || (v && typeof v === "object" ? String(v.event ?? v.type ?? "") : ""), data: v }
    event = ""
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (!line) {
          yield* flush()
          continue
        }
        if (line.startsWith(":")) continue
        if (line.startsWith("event:")) {
          yield* flush()
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
    }
    buf += dec.decode()
    if (buf.startsWith("data:")) data.push(buf.slice(5).trimStart())
    yield* flush()
  } finally {
    // the answer the agent goes away from (a tool call made, a request
    // aborted) closes this generator mid-read: let Trae's connection go,
    // or the read hangs on and the host the next ask reuses is one Trae
    // has dropped — a stream that runs, then dies
    reader.cancel().catch(() => {})
  }
}

// normalised event names: "TokenUsage", "token-usage" → token_usage
export const eventName = (s) =>
  String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "")
