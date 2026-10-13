// A tool step's usage, which Cursor tells only in the dashboard's events: owed, collected, counted once.
import { hashOf } from "./hash.mjs"
import { API } from "./constants.mjs"
import { headersFor } from "./api.mjs"

// A step that calls the caller's tools has no TurnEndedUpdate: Cursor ends
// the turn, and tells what it used, only once the client has run the tools
// and sent their results in the same Run, and the caller runs them after
// the Run is closed (magpie #676). Before that it sends nothing more than
// the conversation's checkpoint and heartbeats, and a cancelled Run ends
// with an error and no usage either. The dashboard's usage events count
// every Run, by its conversation_id, the uncached input apart from what
// was read from the cache and written to it, as TurnEndedUpdate does; one
// shows about 2.5 s after the Run is closed. STEP_WAIT is how long a step's
// is looked for: first after that long, then every so often until the
// end (each ask given `ask` to answer).
//
// Far from Cursor none shows in that time (yetone/magpie#1053: a round
// trip of 4.2 s, the event 4–5 s after the Run closes), and waiting longer
// would hold every tool step longer. So a tool step's Run is owed by its
// conversation (owed): the step counts every event of the conversation's
// owed Runs that has shown by the end of its wait, its own or earlier
// ones, and what hasn't shown is collected by the conversation's next
// steps, in the background from `owedAt` after the Run closed. A step
// whose count is still owed says 0 used; the conversation's steps add up
// to what Cursor counted, some of it a step or two late. A step that ends
// the turn waits for what is still owed, as nothing may follow it soon.
// After `skipAfter` steps in a row of an account's left something owed,
// its steps stop waiting (but every `retryEvery`th), and leave it to the
// next. A debt not collected in `owedFor` is let go. With no
// conversation_id naming the session nothing later could collect a Run's
// event: its step looks for it as before, and is guessed without it.
const STEP_WAIT = { first: 1500, every: 500, until: 6000, ask: 5000, skipAfter: 3, retryEvery: 10, owedAt: 5000, owedFor: 600_000 }

// claimed are the usage events already counted, by conversation and time,
// so that two steps of one conversation never count the same one.
const claimed = new Map()

// owed are what each conversation still owes, by conversation_id: n Runs
// whose events are to be counted, the earliest started at since, looked
// for from ready on; and carry, a count collected that no step gave out.
export const owed = new Map()

// flights are each conversation's collections still going, which a step
// that ends the turn waits for.
const flights = new Map()

// unreadable are the accounts (by token) whose usage events Cursor won't
// give (a 4xx), for owedFor: their steps are guessed, as before, and owe
// nothing. misses are how many steps in a row of an account's left
// something owed.
const unreadable = new Map()
const misses = new Map()
function canRead(tok) {
  const at = unreadable.get(hashOf(tok))
  if (at === undefined) return true
  if (Date.now() - at < STEP_WAIT.owedFor) return false
  unreadable.delete(hashOf(tok))
  return true
}

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
export function addUsage(a, b) {
  if (!b) return a
  if (!a) return { ...b }
  for (const k of Object.keys(a)) a[k] += b[k] ?? 0
  return a
}

// owe adds to conversation conv's debt.
function owe(conv, { since = Date.now(), n = 0, ready = Date.now(), carry = null }) {
  for (const [k, d] of owed) if (Date.now() - d.since > STEP_WAIT.owedFor) owed.delete(k)
  if (n <= 0 && !carry) return
  const d = owed.get(conv)
  if (!d) return void owed.set(conv, { since, n, ready, carry: carry && { ...carry } })
  d.since = Math.min(d.since, since)
  d.n += n
  d.ready = Math.min(d.ready, ready)
  d.carry = addUsage(d.carry, carry)
}

// usageEvents are the dashboard's events of conversation conv from since
// on, the `want` oldest not counted yet, summed: usage (null when none),
// each with its time (events), how many were found (got), and refused
// when the account can't read them.
// Polling, they are looked for as STEP_WAIT says, from `first` on, until
// all show; else asked for once.
export async function usageEvents(tok, conv, since, want, { poll = false, first = STEP_WAIT.first, signal } = {}) {
  const end = Date.now() + STEP_WAIT.until
  const wait = (ms) => new Promise((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true })
  })
  for (const [k, at] of claimed) if (Date.now() - at > 2 * STEP_WAIT.owedFor) claimed.delete(k)
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  let usage = null
  let got = 0
  const events = []
  if (poll) await wait(first)
  while (!signal?.aborted) {
    try {
      const res = await fetch(API + "/aiserver.v1.DashboardService/GetFilteredUsageEvents", {
        method: "POST",
        headers: await headersFor(tok),
        body: JSON.stringify({ teamId: 0, startDate: String(since - 60_000), endDate: String(Date.now() + 60_000), page: 1, pageSize: 50 }),
        signal: AbortSignal.timeout(STEP_WAIT.ask),
      })
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // not this account's to read
        unreadable.set(hashOf(tok), Date.now())
        return { usage, events, got, refused: true }
      }
      const evs = res.ok ? ((await res.json())?.usageEventsDisplay ?? []) : []
      const found = evs
        .filter((e) => e?.conversationId === conv && e.tokenUsage && num(e.timestamp) >= since - 1000 && !claimed.has(conv + "\0" + e.timestamp))
        .sort((a, b) => num(a.timestamp) - num(b.timestamp))
        .slice(0, want - got)
      for (const ev of found) {
        claimed.set(conv + "\0" + ev.timestamp, Date.now())
        const t = ev.tokenUsage
        const u = { input: num(t.inputTokens), output: num(t.outputTokens), cacheRead: num(t.cacheReadTokens), cacheWrite: num(t.cacheWriteTokens), reasoning: 0 }
        usage = addUsage(usage ?? emptyUsage(), u)
        events.push({ at: num(ev.timestamp), usage: u })
        got++
      }
      if (got >= want) break
    } catch {}
    if (!poll || Date.now() + STEP_WAIT.every > end) break
    await wait(STEP_WAIT.every)
  }
  return { usage, events, got, refused: false }
}

// collect takes conversation conv's debt and asks for its events (polling
// when poll): what was carried and what was found (usage), what was
// carried alone (carry) and the events found (events), and whether any is
// still owed (short), which is owed on. What comes back once the Run that
// asked is over (over() true) is carried to the next instead.
function collect(tok, conv, { poll = false, first, signal, over = () => false } = {}) {
  const d = owed.get(conv)
  if (!d) return Promise.resolve({ usage: null, carry: null, events: [], short: false })
  owed.delete(conv)
  const p = (async () => {
    let r = { usage: null, events: [], got: 0 }
    if (d.n > 0 && canRead(tok)) r = await usageEvents(tok, conv, d.since, d.n, { poll, first, signal }).catch(() => r)
    const short = d.n > r.got && canRead(tok)
    if (short) owe(conv, { since: d.since, n: d.n - r.got, ready: d.ready })
    const carry = d.carry && { ...d.carry }
    const usage = addUsage(d.carry, r.usage)
    if (!over()) return { usage, carry, events: r.events ?? [], short }
    owe(conv, { carry: usage })
    return { usage: null, carry: null, events: [], short }
  })()
  const set = flights.get(conv) ?? new Set()
  flights.set(conv, set.add(p))
  p.finally(() => {
    set.delete(p)
    if (!set.size && flights.get(conv) === set) flights.delete(conv)
  })
  return p
}

// ledger is how a Run of conversation conv, started at since, has its
// usage counted, for decode; kept when the conversation_id names the
// session, so that a later Run of it can collect what this one owes. A
// debt the conversation has is collected in the background. own() is a
// step's count once it has called tools: its Run owed, what has shown of
// the debt by the end of the wait (or at once, when the account's never
// show in time); false when nothing has, null when the step is to be
// guessed (not kept, and its event not found, or an account that can't
// read its events). owed(final) is what the Run collected otherwise,
// all that can be had when final. done() ends the Run: what was collected
// and not given out goes back.
//
// What a Run collects is told apart by its event's time: Cursor stamps a
// Run's event as the Run begins (1.4–3.4 s after since), so one from since
// on (less the second usageEvents allows) is this Run's own (mine), and one
// before it, or a count carried, an earlier Run's (theirs). own() gives out only mine, as the step's usage,
// which a client reads as how full its context is; theirs goes out by
// owed(), apart. A Run of its conversation begins only once the one
// before has ended, so the two never meet; were the time off, the step's
// count would be told in the wrong field, never twice nor lost.
export function ledger(tok, conv, since, signal, kept) {
  const key = hashOf(tok)
  let mine = null // this Run's own, collected, not given out yet
  let theirs = null // earlier Runs', collected, not given out yet
  let over = false
  const gather = (opts) =>
    collect(tok, conv, { ...opts, over: () => over }).then((r) => {
      theirs = addUsage(theirs, r.carry)
      for (const e of r.events ?? []) {
        if (e.at >= since - 1000) mine = addUsage(mine, e.usage)
        else theirs = addUsage(theirs, e.usage)
      }
      return r
    })
  let collecting = null
  const debt = kept ? owed.get(conv) : undefined
  const timer = debt ? setTimeout(() => (collecting = gather()), Math.max(0, debt.ready - Date.now())) : null
  timer?.unref?.()
  const takeMine = () => {
    const u = mine
    mine = null
    return u
  }
  const take = () => {
    const u = addUsage(theirs, mine)
    mine = theirs = null
    return u
  }
  return {
    async own() {
      if (!canRead(tok)) return null
      const m = misses.get(key) ?? 0
      const waits = m < STEP_WAIT.skipAfter || m % STEP_WAIT.retryEvery === 0
      if (!kept) {
        const r = waits ? await usageEvents(tok, conv, since, 1, { poll: true, signal }).catch(() => ({})) : {}
        if (r.usage) misses.delete(key)
        else if (!r.refused) misses.set(key, m + 1)
        return r.usage ?? null
      }
      owe(conv, { since, n: 1, ready: Date.now() + STEP_WAIT.owedAt })
      if (waits) {
        const r = await gather({ poll: true, signal })
        if (!canRead(tok)) return null
        if (r.short) misses.set(key, m + 1)
        else misses.delete(key)
      } else misses.set(key, m + 1)
      return takeMine() ?? false
    },
    async owed(final) {
      if (!kept) return null
      if (final) {
        await collecting
        await Promise.all([...(flights.get(conv) ?? [])])
        if (owed.has(conv)) await gather({ poll: owed.get(conv).n > 0, first: 0, signal })
      }
      return take()
    },
    done() {
      over = true
      clearTimeout(timer)
      const u = take()
      if (u) owe(conv, { carry: u })
    },
  }
}
