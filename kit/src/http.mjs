import { STATUS_CODES } from "node:http"

// where Go's words differ from Node's (magpie words a refusal as Go's
// http.StatusText does); 509 Go has no words for
const GO_TEXT = {
  413: "Request Entity Too Large",
  414: "Request URI Too Long",
  416: "Requested Range Not Satisfiable",
  418: "I'm a teapot",
  509: "",
}

/** A status as magpie says it (Go's http.StatusText); one with no words is "HTTP <n>", never empty. */
export const statusText = (status) => (GO_TEXT[status] ?? STATUS_CODES[status]) || `HTTP ${status}`

/** Resolves after ms. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
