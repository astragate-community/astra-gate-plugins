// WorkBuddy's plans as OpenCode provider plugins, one per build: WorkBuddy (China, copilot.tencent.com) and
// WorkBuddy AI (international, www.workbuddy.ai). Based on @magpie-community/opencode-workbuddy-auth 0.1.19 (MIT);
// adds the daily check-in.
import { SITES } from "./sites.mjs"
import { makePlugin } from "./plugin.mjs"

export const WorkBuddyAuthPlugin = makePlugin(SITES.workbuddy)
export const WorkBuddyAIAuthPlugin = makePlugin(SITES["workbuddy-ai"])
