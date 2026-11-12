// A chat on Cursor's agent API over HTTP/1.1, as Cursor's clients run one where HTTP/2 is not to be had: the reply streams
// down from AgentService/RunSSE (Connect frames; the host reads it and hands the frames to transformResponse), and every
// client message (the run request, blob answers, tool lists, heartbeats) goes up on a BidiAppend call of its own, numbered
// from 0 (the v1 plugin's transport.mjs, openH1). Both are on api2.cursor.sh, which the plugin's net: permission covers: the
// HTTP/2 Run v1 preferred went to a regional agent host that server config names, which a static permission can't.
import { encoding, http, timers } from 'astra';
import { API } from './constants.js';
import { clientVersion } from './api.js';
import { failure } from './errors.js';
import { frame, pb } from './protobuf.js';

export const RUN = {
  appendWait: 60_000, // ms a BidiAppend may take before the Run fails, as cursor-agent's appendTimeoutMs
  heartbeat: 5_000, // ms between the "still here" messages the CLI sends
  forget: 30 * 60_000, // a Run the host never disposed (its request failed after prepare) is dropped after this
};

/** The Runs in progress, by request id: what their reply needs that JSON can't carry (the blobs) and their append queue. */
export const runs = new Map();

/** The headers of a Run's calls. */
export function runHeaders(tok, id) {
  return {
    authorization: `Bearer ${tok}`,
    'connect-protocol-version': '1',
    'x-cursor-client-version': clientVersion(),
    'x-cursor-client-type': 'cli', // else Cursor adds a prompt of its own
    'x-ghost-mode': 'true', // privacy mode: nothing kept for training
    'x-request-id': id,
    // none of Cursor's own tools, only the caller's
    'x-cursor-agent-allowed-tools': 'mcp_tool_call,get_mcp_tools_tool_call',
    'x-cursor-streaming': 'true',
    'accept-encoding': 'identity',
    accept: '*/*',
  };
}

/** The RunSSE request's body: the request id, as one Connect frame. */
export const runBody = (id) => frame(pb().str(1, id).done());

/** Starts a Run's bookkeeping. */
export function open(id, tok, extra) {
  // a Run the host never disposed (its request failed after prepare) is dropped once it is old
  const now = Date.now();
  for (const [old, r] of runs) if (now - r.at > RUN.forget) close(old);
  const run = { id, tok, at: now, seq: 0, chain: Promise.resolve(), failed: null, closed: false, beat: 0, ...extra };
  runs.set(id, run);
  return run;
}

/** One client message up, as BidiAppend number n; a failure is kept for the reply to say. */
async function append(run, msg, n, timeoutMs = RUN.appendWait) {
  const body = pb().str(1, encoding.hex.encode(msg)).bytes(2, pb().str(1, run.id).done()).varint(3, n).done();
  const ms = Math.min(timeoutMs + Math.ceil(body.length / 65536) * 1000, 120_000);
  let res;
  try {
    res = await http.fetch(API + '/aiserver.v1.BidiService/BidiAppend', {
      method: 'POST',
      headers: { ...runHeaders(run.tok, run.id), 'content-type': 'application/proto' },
      body,
      timeoutMs: ms,
    });
  } catch (e) {
    const timeout = e?.code === 'timeout';
    throw Object.assign(new Error(timeout ? `BidiAppend got no answer in ${Math.round(ms / 1000)}s` : `BidiAppend: ${e?.message ?? e}`), { status: timeout ? 504 : 502 });
  }
  if (!res.ok) {
    const f = failure(res.status, await res.text().catch(() => ''));
    throw Object.assign(new Error(f.message), { status: f.status });
  }
}

/** The Run's first message, waited for (prepare fails when Cursor won't take it, so the gateway can say so or fail over). */
export async function first(run, msg, timeoutMs) {
  const n = run.seq++;
  await append(run, msg, n, timeoutMs);
}

/** Puts a client message on the Run, after the ones before it; not waited for. */
export function send(run, msg) {
  if (run.closed) return;
  const n = run.seq++;
  run.chain = run.chain.then(() => (run.closed ? undefined : append(run, msg, n))).catch((e) => {
    run.failed ??= { status: e.status ?? 502, message: e.message };
  });
}

/** Starts the heartbeat: an empty message (field 7) every few seconds, as the CLI says it is still there. */
export function beat(run) {
  if (run.beat) return;
  run.beat = timers.setInterval(() => send(run, pb().bytes(7, new Uint8Array(0)).done()), RUN.heartbeat);
}

/** Ends a Run's side of things: no more appends, no heartbeat. */
export function close(id) {
  const run = runs.get(id);
  if (!run) return;
  run.closed = true;
  if (run.beat) timers.clearInterval(run.beat);
  runs.delete(id);
}
