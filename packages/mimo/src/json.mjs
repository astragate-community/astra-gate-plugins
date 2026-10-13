// JSON.parse that answers undefined for text that isn't JSON (a sign-in page where an API answer was due).
export function tryJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
