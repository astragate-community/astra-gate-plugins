// Factory: a model request as droid sends it to Factory's API: where it goes, the headers, the body.
import { AstraError, crypto } from "astra";
import { COUNT_TOKENS, PATHS } from "./constants.js";
import { anthropicBody } from "./anthropic-request.js";
import { base, factoryHeaders } from "./api.js";
import { byId } from "./models.js";
import { droidBody } from "./opening.js";
import { expectWrapped } from "./reply.js";
import { wrapAnthropicTools } from "./tools.js";

// the session id this engine's requests carry (droid sends one per process)
let session;
const sessionId = () => (session ??= crypto.randomUUID());

/**
 * What to send for one request the host handed `prepare`, with the live credential `c`: the url (an EU org is served
 * from Factory's EU region), droid's headers and the adapted body.
 */
export function shaped(c, req) {
  const protocol = req.protocol;
  if (!PATHS[protocol]) throw new AstraError("not_supported", `Factory has no ${protocol} endpoint`);
  if (c.premBaseHost) {
    throw new AstraError("not_supported", `This Factory organization is served from its own host (${c.premBaseHost}); a v2 plugin can only reach Factory's public API hosts`);
  }
  const counting = protocol === "anthropic" && String(req.path ?? "").split("?")[0].endsWith("/count_tokens");
  const url = base(c) + (counting ? COUNT_TOKENS : PATHS[protocol]);
  const model = byId.get(req.model ?? req.body?.model ?? "");
  const upstream = model ? model.upstream : protocol === "anthropic" ? "anthropic" : "openai";
  const headers = {
    ...factoryHeaders(c),
    "x-api-provider": upstream,
    "x-session-id": sessionId(),
    "x-assistant-message-id": crypto.randomUUID(),
    "x-provider-routing-source": "registry_default",
  };
  if (upstream === "openai") headers["openai-platform"] = "org-bHuLtG1fGmYk5YaOihAAXFBw";
  // droid's Anthropic client is made with the key "placeholder", which Anthropic's SDK sends beside the bearer token
  if (protocol === "anthropic") headers["x-api-key"] = "placeholder";
  // another agent's request opens as droid's does
  if (protocol !== "anthropic") return { url, headers, body: droidBody(protocol, req.body) };
  // a tool whose schema opens with anyOf / oneOf / allOf is wrapped for Factory; the reply unwraps it (reply.js)
  const { body, names } = wrapAnthropicTools(anthropicBody(req.body));
  if (!counting) expectWrapped(req.model ?? req.body?.model ?? "", names);
  return { url, headers, body };
}
