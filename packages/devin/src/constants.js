// Devin's endpoints and the CLI the requests say they come from.
export const PROVIDER = 'devin';
export const SERVER = 'https://server.codeium.com';
export const AUTHORIZE = 'https://app.devin.ai/auth/cli/continue';
export const EXCHANGE = '/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode';
export const USER_STATUS_RPC = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
// the CLI the requests say they come from
export const CLI_VERSION = '3000.11.3';
// The browser sign-in's callback. v1 listened on a free 127.0.0.1 port; a v2 plugin cannot listen, so nothing answers
// here and the browser's address bar holds the callback URL, which the user pastes back.
export const REDIRECT = 'http://127.0.0.1:53682/callback';
