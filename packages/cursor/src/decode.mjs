// What the Run says, followed into the answer's pieces; and what the server asks the client to run.
import { field, fields, mapOf, pb, pbNum, pbStr } from "./protobuf.mjs"
import { badGateway, failure } from "./errors.mjs"
import { emptyUsage } from "./step-usage.mjs"
import { EMPTY } from "./constants.mjs"
import { randomBytes } from "node:crypto"
import { env, toolDef } from "./run-request.mjs"

// usageOf is a TurnEndedUpdate as magpie counts usage, as the built-in's
// cursorUsage has it (magpie #498). Its input_tokens is the whole prompt,
// what was read from the cache and written to it included, as Cursor's
// own client has it (it takes both out to get the prompt's uncached
// rest); input is that rest, the cache added back for prompt_tokens. Its
// reasoning_tokens is kept as reasoning.
export function usageOf(uf) {
  const [inp, cr, cw] = [pbNum(uf, 1), pbNum(uf, 3), pbNum(uf, 4)]
  return { input: Math.max(inp - cr - cw, 0), output: pbNum(uf, 2), cacheRead: cr, cacheWrite: cw, reasoning: pbNum(uf, 5) }
}

// decode follows the server's messages into the answer's pieces until the
// turn ends, or the model has made its tool calls.
export async function* decode(stream, { send, blobs, tools, estimate, close, stepUsage, owedUsage }) {
  let calls = 0
  // ended: Cursor said what the turn used
  let ended = false
  let listed = 0
  let said = 0
  // wrote: the reply's text alone; a turn of thinking only says nothing
  let wrote = 0
  // what the Run sent, for an empty reply to name (#60): the thinking's
  // length, Cursor's own tools it asked for and was refused, and updates
  // and messages this doesn't read
  const seen = { thinking: 0, refused: new Map(), updates: new Map(), messages: new Map() }
  const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
  const empty = (how) => ({ error: badGateway("an empty reply" + emptyWhy(how, seen, ended ? usage : null)) })
  let usage = emptyUsage()
  // counted: the step's usage is the dashboard's events, its own counted
  // with it or by a later step (ledger), never guessed
  let counted = false
  // finish is the step's end, with what earlier steps owed (more), which
  // is no reason not to guess the step's own. The step's usage is its own
  // Run's alone: a client reads its prompt_tokens as how full the context
  // is (pi, OpenCode), and an earlier step's prompt added to it read twice
  // the context. What earlier steps owed goes apart, as magpie_deferred,
  // which magpie counts with the step and no client reads.
  const finish = (more) => {
    if (!counted && !usage.output) usage.output = Math.floor((said + 3) / 4)
    // a guess only when Cursor counted nothing: a prompt read whole from
    // the cache leaves no uncached rest, and is no reason to guess; nor is
    // a prompt counted from the events
    if (!counted && !usage.input && !usage.cacheRead && !usage.cacheWrite) usage.input = estimate
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    const deferred = more && more.input + more.output + more.cacheRead + more.cacheWrite > 0
    return {
      stop: calls > 0 ? "tool_calls" : "stop",
      usage: {
        prompt_tokens: prompt,
        completion_tokens: usage.output,
        total_tokens: prompt + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
        ...(usage.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
        ...(deferred
          ? {
              magpie_deferred: {
                prompt_tokens: more.input + more.cacheRead + more.cacheWrite,
                completion_tokens: more.output,
                cached_tokens: more.cacheRead,
                cache_write_tokens: more.cacheWrite,
              },
            }
          : {}),
      },
    }
  }
  // settled is finish once a step that called tools has its usage: the
  // dashboard's count, the Run closed first, when the turn didn't end (or
  // owed); and with what the conversation's earlier steps owed, which a
  // step that ends the turn waits for
  const settled = async () => {
    if (calls > 0 && !ended && stepUsage) {
      close?.()
      const u = await stepUsage().catch(() => null)
      if (u) usage = u
      counted = u === false || !!u
    }
    return finish(owedUsage ? await owedUsage(calls === 0).catch(() => null) : null)
  }
  const closeExec = (id) => send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done())
  try {
    for await (const f of stream) {
      if (f.end) {
        const e = failure(200, f.data)
        if (e.status < 200 || e.status > 299) yield { error: e }
        else if (wrote === 0 && calls === 0) yield empty(endFrame(f.data))
        else yield await settled()
        return
      }
      for (const m of fields(f.data)) {
        switch (m.num) {
          case 1: // interaction_update
            for (const u of fields(m.data)) {
              const uf = fields(u.data)
              switch (u.num) {
                case 1: {
                  // text
                  const t = pbStr(uf, 1)
                  if (t) {
                    said += t.length
                    wrote += t.length
                    yield { text: t }
                  }
                  break
                }
                case 4: {
                  // thinking
                  const t = pbStr(uf, 1)
                  if (t) {
                    said += t.length
                    seen.thinking += t.length
                    yield { reasoning: t }
                  }
                  break
                }
                case 14: // turn ended, with what it used
                  usage = usageOf(uf)
                  ended = true
                  if (calls === 0) {
                    // nothing written and nothing called: an empty reply,
                    // which the client asks again, not a finished turn
                    yield wrote === 0 ? empty("Cursor ended the turn") : await settled()
                    return
                  }
                  break
                case 27: // how many tool calls the step makes, sent before them
                  listed = pbNum(uf, 1)
                  if (listed > 0 && calls >= listed) {
                    yield await settled()
                    return
                  }
                  break
                default:
                  count(seen.updates, u.num)
              }
            }
            break
          case 2: {
            // exec_server_message: the server asks the client to run something
            const call = exec(m.data, tools, send, closeExec, seen.refused)
            if (call) {
              said += call.args.length
              yield { tool: { index: calls++, ...call } }
            }
            if (listed > 0 && calls >= listed) {
              // every call made: the caller runs them
              yield await settled()
              return
            }
            break
          }
          case 4: {
            // kv_server_message: a blob wanted, or one to keep
            const kv = fields(m.data)
            const id = pbNum(kv, 1)
            for (const k of kv) {
              if (k.num === 2) {
                const want = field(fields(k.data), 1)?.data.toString("hex") ?? ""
                const b = blobs.get(want)
                const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, "blob not found"))
                send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done())
              } else if (k.num === 3) {
                // the server's own record of the turn, not needed
                send(pb().bytes(3, pb().varint(1, id).bytes(3, EMPTY)).done())
              }
            }
            break
          }
          default:
            count(seen.messages, m.num)
        }
      }
    }
    if (calls > 0) {
      yield await settled()
      return
    }
    yield { error: badGateway("the reply broke off: EOF") }
  } catch (e) {
    if (calls > 0 && /EOF/.test(e?.message ?? "")) {
      yield await settled()
      return
    }
    yield { error: badGateway("the reply broke off: " + (e?.message ?? e)) }
  }
}

// endFrame is how a Run's Connect end frame that said no error reads in
// an empty reply's words: its JSON, cut short, or that it was empty.
function endFrame(data) {
  const t = Buffer.from(data ?? []).toString("utf8").trim()
  if (!t || t === "{}") return "the Run's stream ended (an empty end frame)"
  return `the Run's stream ended (end frame: ${t.length > 300 ? t.slice(0, 300) + "…" : t})`
}

// emptyWhy is what an empty reply says of what came before it (#60): how
// it ended, the thinking, the turn's own count of output, Cursor's own
// tools refused, and what Cursor sent that isn't read. Field numbers are
// agent.v1's, so a report names the message that wasn't understood.
function emptyWhy(how, seen, usage) {
  const list = (m) => [...m].map(([k, n]) => (n > 1 ? `#${k} ×${n}` : `#${k}`)).join(", ")
  const parts = [how]
  parts.push(seen.thinking ? `after ${seen.thinking} chars of thinking, no text and no tool call` : "with no thinking, no text and no tool call")
  if (usage) parts.push(`Cursor counted ${usage.output} output tokens`)
  if (seen.refused.size) parts.push(`Cursor's own tools asked for and refused: ${list(seen.refused)}`)
  if (seen.updates.size) parts.push(`updates not read: ${list(seen.updates)}`)
  if (seen.messages.size) parts.push(`messages not read: ${list(seen.messages)}`)
  return ` (${parts.join("; ")}; try again)`
}

// exec answers what the server asks the client to run: a call of the
// caller's tools is returned, the list of them is given, and anything else
// is refused.
export function exec(msg, tools, send, closeExec, refused) {
  const es = fields(msg)
  const id = pbNum(es, 1)
  const execID = pbStr(es, 15)
  const answer = (num, res) => {
    send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done())
    closeExec(id)
  }
  for (const e of es) {
    switch (e.num) {
      case 11: {
        // mcp_args: a call of the caller's tools
        const a = fields(e.data)
        const args = mapOf(a, 2)
        const name = pbStr(a, 5) || pbStr(a, 1).replace(/^magpie-/, "")
        // an OpenAI model's id is its call's and its item's, a line apart,
        // which no caller would take as an id: the line goes as __
        const cid = pbStr(a, 3).replaceAll("\n", "__") || "call_" + randomBytes(12).toString("hex")
        return { id: cid, name, args: JSON.stringify(args) }
      }
      case 36: {
        // mcp_state_exec_args: the tools there are
        const srv = pb().str(1, "magpie").str(2, "magpie").str(7, "connected")
        for (const t of tools) srv.bytes(5, toolDef(t))
        answer(36, pb().bytes(1, pb().bytes(1, srv)))
        return null
      }
      case 10: // request_context_args
        answer(10, pb().bytes(1, pb().bytes(1, pb().bytes(4, env()))))
        return null
    }
  }
  // a shell, a file read or an edit of Cursor's own: never run
  const kind = es.find((e) => e.num !== 1 && e.num !== 15)?.num ?? 0
  refused?.set(kind, (refused.get(kind) ?? 0) + 1)
  send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, "not available"))).done())
  closeExec(id)
  return null
}
