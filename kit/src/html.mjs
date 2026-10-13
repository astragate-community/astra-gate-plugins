const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => escapes[c])

/** The page a browser sign-in's callback shows: a mark, a title and a line; it follows the system's light or dark. */
export function resultPage(ok, title, text) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{text-align:center;max-width:28rem;padding:1rem}
.d{font-size:2rem;color:${ok ? "#2a9d5c" : "#c0392b"}}</style>
<main><div class="d">${ok ? "✓" : "✕"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main>`
}
