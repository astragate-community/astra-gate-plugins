// WorkBuddy's plans as OpenCode provider plugins, one per build: WorkBuddy (China, copilot.tencent.com) and
// WorkBuddy AI (international, www.workbuddy.ai). Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md);
// adds the daily check-in.
import { SITES } from "./sites.mjs"
import { makePlugin } from "./plugin.mjs"

export const WorkBuddyAuthPlugin = makePlugin(SITES.workbuddy)
export const WorkBuddyAIAuthPlugin = makePlugin(SITES["workbuddy-ai"])
