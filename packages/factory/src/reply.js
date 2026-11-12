// Factory's reply (manifest `reply: { framing: ndjson, output: anthropic }`, see the note below). Two jobs, as in v1:
//  - the arguments of a tool whose schema was wrapped (tools.js) are unwrapped again, in a JSON message and in a stream;
//  - a 403 is worded with what to do about it (and the host's `refresh` mends the organization, see session.js `repair`).
// Everything else — chat, responses and anthropic replies alike — is passed on as it came, event for event.
//
// Why ndjson: the framing is one per provider and the provider speaks three protocols, in streams and in plain JSON
// bodies. An `sse` reader would swallow a JSON body as a stream with no events, so the plugin takes the lines (`{ text }`
// for `event:` / `data:`, `{ json }` for a one-line body) and puts events back together itself. A `data:` event that
// spans several lines would not survive; none of these three APIs writes one.
import { argument, isObject } from "./tools.js";
import { explain, statusLine, vendorError } from "./errors.js";

// ---- what prepare wrapped, for the reply of the same request ----------------------------------------------------
// The reply side is not told the request's tools, so prepare leaves the names it wrapped here per model (one engine runs
// both). A name stays for 15 minutes; a reply unwraps a tool of that name only when its input is exactly { arguments }.
const TTL_MS = 15 * 60_000;
const wrapped = new Map();

export function expectWrapped(model, names) {
  if (!names.size) return;
  const now = Date.now();
  const seen = wrapped.get(model) ?? new Map();
  for (const [k, at] of seen) if (now - at > TTL_MS) seen.delete(k);
  for (const name of names) seen.set(name, now);
  wrapped.set(model, seen);
}

const namesFor = (model) => {
  const now = Date.now();
  const seen = wrapped.get(model);
  return new Set(seen ? [...seen].filter(([, at]) => now - at <= TTL_MS).map(([k]) => k) : []);
};

export const forget = () => wrapped.clear();

// ---- unwrapping ---------------------------------------------------------------------------------------------------

const isWrapped = (input) => isObject(input) && Object.keys(input).length === 1 && Object.prototype.hasOwnProperty.call(input, argument);
const unwrapped = (input) => (isWrapped(input) ? input[argument] : input);

/** A JSON message with its wrapped tools' arguments unwrapped (a changed copy of what changed, else the message itself). */
export function unwrapMessage(message, names) {
  if (!names.size || !Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block?.type !== "tool_use" || !names.has(block.name) || !isWrapped(block.input)) return block;
    changed = true;
    return { ...block, input: block.input[argument] };
  });
  return changed ? { ...message, content } : message;
}

const failed = (status, message) => ({ $error: { status, message } });
const refusal = (data) => data?.error?.message ?? data?.message ?? "Factory answered with an error";

export const transformResponse = {
  start(res, ctx) {
    const s = ctx.state;
    s.protocol = ctx.request.protocol;
    s.names = s.protocol === "anthropic" ? namesFor(ctx.request.model) : new Set();
    s.blocks = new Map();
    s.buf = "";
    s.event = undefined;
    if (res.status === 403) {
      // the refusal, then what to do about it (the vendor's own words stay in, `refresh` reads them)
      const text = res.body ?? "";
      return { error: { status: 403, message: `${vendorError(text, statusLine(403))} — ${explain(403, text)}` } };
    }
  },

  frame(f, ctx) {
    const s = ctx.state;
    const stream = ctx.request.stream;
    const out = (data, event) => (s.protocol === "chat" ? data : { event: event ?? data?.type ?? "message", data });
    if (f.json !== undefined) {
      // a whole one-line JSON body
      if (!stream) return void (s.body = f.json);
      if (f.json?.error || f.json?.type === "error") return out({ type: "error", error: f.json.error ?? { type: "api_error", message: refusal(f.json) } }, "error");
      return failed(502, "Factory answered a streaming request with a plain body");
    }
    const line = String(f.text ?? "");
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      s.event = line.slice(6).trim();
      return;
    }
    if (!line.startsWith("data:")) {
      s.buf += line + "\n"; // a pretty-printed JSON body
      return;
    }
    const raw = line.slice(5).replace(/^ /, "");
    const event = s.event;
    s.event = undefined;
    if (raw.trim() === "[DONE]") return stream ? "[DONE]" : undefined;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return failed(502, "Invalid JSON in Factory's event stream");
    }
    if (!stream) {
      if (data?.type === "message") s.body = data;
      return;
    }
    if (!isObject(data)) return failed(502, "Invalid JSON in Factory's event stream");
    return s.names.size ? streamed(s, data, event, out) : out(data, event);
  },

  end(ctx) {
    const s = ctx.state;
    if (s.blocks?.size) return failed(502, "Factory: incomplete wrapped tool arguments");
    if (ctx.request.stream) {
      // a body that arrived as lines is not a stream
      if (s.buf.trim()) {
        try {
          const body = JSON.parse(s.buf);
          return s.protocol === "chat" ? { error: body?.error ?? { message: refusal(body) } } : { event: "error", data: { type: "error", error: body?.error ?? { type: "api_error", message: refusal(body) } } };
        } catch {}
      }
      return;
    }
    if (s.body === undefined && s.buf.trim()) {
      try {
        s.body = JSON.parse(s.buf);
      } catch {}
    }
    if (s.body === undefined) return failed(502, "Factory answered with no body");
    return unwrapMessage(s.body, s.names);
  },
};

// A streamed Anthropic event, with a wrapped tool's argument events held back until its block ends: the block starts with
// an empty input, and its whole unwrapped arguments go out as one delta just before content_block_stop.
function streamed(s, event, name, out) {
  const type = event.type ?? name;
  if (type === "content_block_start" && event.content_block?.type === "tool_use" && s.names.has(event.content_block.name)) {
    if (s.blocks.has(event.index)) return failed(502, "Factory: duplicate wrapped tool block");
    s.blocks.set(event.index, { json: "", initial: event.content_block.input });
    return out({ ...event, content_block: { ...event.content_block, input: {} } }, name);
  }
  const block = s.blocks.get(event.index);
  if (block && type === "content_block_delta" && event.delta?.type === "input_json_delta") {
    if (typeof event.delta.partial_json !== "string") return failed(502, "Factory: invalid tool argument delta");
    block.json += event.delta.partial_json;
    return;
  }
  if (block && type === "content_block_stop") {
    let input;
    try {
      input = block.json ? JSON.parse(block.json) : block.initial;
    } catch {
      return failed(502, "Factory: invalid wrapped tool arguments");
    }
    if (!isWrapped(input)) return failed(502, "Factory: a wrapped tool returned invalid arguments");
    s.blocks.delete(event.index);
    const delta = { type: "content_block_delta", index: event.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(unwrapped(input)) } };
    return [out(delta, "content_block_delta"), out(event, name)];
  }
  if (type === "error") s.blocks.clear(); // keep the upstream error
  return out(event, name);
}
