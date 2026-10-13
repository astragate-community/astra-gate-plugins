/** The text of a chat message's content: a string, or the text parts of a parts array. */
export const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") : ""
