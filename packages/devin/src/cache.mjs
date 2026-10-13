// What a per-account cache of something read from Devin (the model list, the images each model takes) shares:
// the value is kept FRESH; one past its time is served while it is read again, one that failed is asked again
// after RETRY, and a read already under way is joined, not repeated.
import { FRESH, RETRY } from "./constants.mjs"

/** A cache entry; `extra` adds the entry's own fields. */
export const entryOf = (extra = {}) => ({ value: null, at: 0, failed: 0, asking: null, ...extra })

/**
 * Reads again if the entry's value is missing or stale and `allowed()` says it may be asked: `load()` returns
 * the new value, or undefined to leave the entry as it is; a throw marks the read failed. A first read is
 * waited for when `wait` is true; a stale value is served at once. Returns the entry.
 */
export async function refreshed(c, { load, allowed = () => true, wait = true }) {
  const ask = () =>
    (c.asking ??= (async () => {
      try {
        const value = await load()
        if (value !== undefined) Object.assign(c, { value, at: Date.now(), failed: 0 })
      } catch {
        c.failed = Date.now()
      } finally {
        c.asking = null
      }
    })())
  if ((!c.value || Date.now() - c.at >= FRESH) && Date.now() - c.failed >= RETRY && allowed()) {
    const p = ask()
    if (wait && !c.value) await p
  }
  return c
}
