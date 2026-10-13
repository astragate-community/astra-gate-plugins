// What the plugin saves with an account's key (its plan), through OpenCode's client
import { ID } from "./constants.mjs"
import { subsSeen } from "./account.mjs"

// saveMetadata merges patch into the saved account's metadata; a client that can't save, or a save that fails, is let be.
export async function saveMetadata(client, auth, patch) {
  if (!client?.auth?.set) return
  try {
    await client.auth.set({ path: { id: ID }, body: { ...auth, metadata: { ...(auth?.metadata ?? {}), ...patch } } })
  } catch {}
}

// markGo keeps a key as Go's, for its models and endpoint: in the
// subscriptions seen, and saved with the key as usage saves the plan read
export async function markGo(client, key, auth) {
  const was = subsSeen.get(key)?.sub
  subsSeen.set(key, { sub: { id: was?.plan === "Go" ? was.id : "", plan: "Go" }, at: Date.now() })
  if (auth?.metadata?.plan === "Go") return
  await saveMetadata(client, auth, { plan: "Go" })
}
