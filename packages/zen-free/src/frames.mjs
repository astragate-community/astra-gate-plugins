// Cutting a byte stream into SSE frames without altering a byte: each frame keeps its raw text, so an event the
// guard does not change is forwarded exactly as Zen sent it.
import { MAX_BYTES } from "./constants.mjs"
import { GuardError } from "./guard-core.mjs"
import { splitField } from "./sse.mjs"

/** Yields { lines, name, text, raw } per event from a reader of bytes; throws a GuardError on a bad or cut-off stream. */
export async function* framesFrom(reader) {
  let parts = []
  let lineBytes = 0
  let eventBytes = 0
  let lines = []
  let rawLines = []
  let skipLF = false
  let pendingFrame
  let firstLine = true
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  function checkEventSize() {
    if (eventBytes > MAX_BYTES) throw new GuardError("Upstream SSE event exceeds the 32 MiB buffer limit")
  }
  function append(value) {
    eventBytes += value.byteLength
    checkEventSize()
    if (value.byteLength) {
      parts.push(value)
      lineBytes += value.byteLength
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (pendingFrame) {
        yield pendingFrame
        eventBytes = 0
      }
      if (eventBytes || lineBytes || lines.length) throw new GuardError("Upstream SSE ended inside an event")
      return
    }
    let start = 0
    if (skipLF && value.length) {
      if (value[0] === 10) {
        eventBytes++
        if (pendingFrame) pendingFrame.raw += "\n"
        else rawLines[rawLines.length - 1] += "\n"
        start = 1
      }
      checkEventSize()
      skipLF = false
      if (pendingFrame) {
        const frame = pendingFrame
        pendingFrame = null
        eventBytes = 0
        yield frame
      }
    }
    for (let offset = start; offset < value.length; offset++) {
      if (value[offset] !== 10 && value[offset] !== 13) continue
      append(value.subarray(start, offset))
      eventBytes++
      checkEventSize()
      const bytes = new Uint8Array(lineBytes)
      let cursor = 0
      for (const part of parts) {
        bytes.set(part, cursor)
        cursor += part.length
      }
      let line
      try {
        line = decoder.decode(bytes)
      } catch {
        throw new GuardError("Invalid UTF-8 in upstream SSE event")
      }
      parts = []
      lineBytes = 0
      let rawLine = line + String.fromCharCode(value[offset])
      if (firstLine) {
        line = line.replace(/^\uFEFF/, "")
        firstLine = false
      }
      if (value[offset] === 13) {
        if (value[offset + 1] === 10) {
          rawLine += "\n"
          offset++
          eventBytes++
          checkEventSize()
        } else if (offset + 1 === value.length) skipLF = true
      }
      start = offset + 1
      rawLines.push(rawLine)
      if (line) {
        lines.push(line)
      } else {
        const frameLines = lines
        lines = []
        let name = ""
        const data = []
        for (const item of frameLines) {
          const [key, content] = splitField(item)
          if (key === "event") name = content
          if (key === "data") data.push(content)
        }
        const frame = {
          lines: frameLines,
          name,
          text: data.join("\n"),
          raw: rawLines.join(""),
        }
        rawLines = []
        if (skipLF) {
          // Preserve a trailing CRLF even when its LF arrives in the next chunk.
          pendingFrame = frame
        } else {
          eventBytes = 0
          yield frame
        }
      }
    }
    append(value.subarray(start))
  }
}
