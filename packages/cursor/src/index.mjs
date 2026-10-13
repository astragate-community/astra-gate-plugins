// Cursor subscriptions as an OpenCode provider plugin, served through the
// API cursor-agent talks to. Based on @magpie-community/opencode-cursor-auth 0.2.11 (MIT), ported from magpie's
// built-in Cursor account (internal/provider/cursor*.go, internal/gateway/cursor.go).
//
// An account is a Cursor access token, got one of three ways (signin.mjs, session.mjs, cli.mjs):
// - the sign-in cursor-agent does (cursor.com/loginDeepControl with a PKCE
//   challenge, then /auth/poll until the browser has signed in);
// - the token cursor-agent itself keeps (the Mac keychain, else its
//   auth.json), read each time and never written;
// - a Cursor API key, exchanged for a token as the CLI does with
//   CURSOR_API_KEY.
//
// Requests go to AgentService/Run, a Connect stream both ways over HTTP/2 (transport.mjs, run.mjs).
// Where HTTP/2 can't open one (a proxy or network that blocks it), the Run
// goes as Cursor's clients run it without HTTP/2: its replies down one
// server stream, AgentService/RunSSE, and each client message up as a call
// of its own, BidiService/BidiAppend, both over HTTP/1.1 on api2.
// Cursor keeps a conversation on its client: each message of the prompt is
// an AI SDK message in JSON, a blob named by its sha256, which the server
// asks the client for as it reads them (conversation.mjs, run-request.mjs). So each request goes whole, as such
// a conversation, the caller's system prompt at its head; the Run only
// resumes it. The caller's tools are MCP tools, which the model calls
// through Cursor's CallDynamicTool: the server hands each call to the
// client to run, and once it has said how many a step made, the stream is
// closed and the calls go back to OpenCode as a chat completion's tool
// calls (decode.mjs). Nothing else the server asks the client to run (a shell, a file
// read) is run.
//
// OpenCode speaks chat completions to it (@ai-sdk/openai-compatible); the
// fetch here answers them (chat.mjs, reply.mjs).
export { CursorAuthPlugin } from "./plugin.mjs"
