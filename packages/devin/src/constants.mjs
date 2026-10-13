// Devin's endpoints, the CLI the requests say they come from, and the timings.
export const ID = "devin"
export const CHAT = "@ai-sdk/openai-compatible"

export const SERVER = "https://server.codeium.com"
export const AUTHORIZE = "https://app.devin.ai/auth/cli/continue"
export const EXCHANGE = "/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode"
export const USER_STATUS_RPC = "/exa.seat_management_pb.SeatManagementService/GetUserStatus"
export const CHAT_RPC = "/exa.api_server_pb.ApiServerService/GetChatMessage"
export const MODEL_CONFIGS_RPC = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs"
// the CLI the requests say they come from
export const CLI_VERSION = "3000.11.3"
// the AI SDK is given a chat completions URL; the loader's fetch answers
// every request itself, so nothing is ever sent here
export const BASE = SERVER + "/devin/v1"
export const SIGN_IN_TIMEOUT = 10 * 60 * 1000
// how long the CLI's model list is kept, and how long a failed read waits
export const FRESH = 5 * 60 * 1000
export const RETRY = 60 * 1000
