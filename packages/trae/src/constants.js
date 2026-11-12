// Trae's chat takes text only and has no turn for a tool call or its result. The agent's tools are named to it natively
// and in a system prompt that asks for each call as a tagged block; earlier calls and their results go in as text.
export const OPEN = '<tool_call>';
export const CLOSE = '</tool_call>';
