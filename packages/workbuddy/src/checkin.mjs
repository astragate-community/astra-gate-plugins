// WorkBuddy: the daily check-in (签到), magpie's auth.checkin.
import { postMeter } from "./api.mjs"
import { statusText } from "@astragate-community/plugin-kit"

// Both builds take POST /billing/meter/daily-checkin. A first press answers HTTP 200 {code: 0, data: {credit,
// streak_days, is_streak_day}}; a repeat the same day HTTP 400 with code 10001 and no data — so judge by the
// code, not the HTTP status. checkin-activity-status tells the streak and credits of a day pressed before.
const PRESS = "/billing/meter/daily-checkin"
const ACTIVITY = "/billing/meter/checkin-activity-status"
const ALREADY = 10001
const CAPTCHA = /captcha|验证码|人机|滑块/i

export const count = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0
}

/** Presses the check-in for an account whose token is fresh: {outcome, credit?, streak?, message?}. */
export async function checkinOf(site, a) {
  const r = await postMeter(site, a, PRESS)
  if (r.code === 0 && r.status >= 200 && r.status < 300) return { outcome: "claimed", credit: count(r.data?.credit), streak: count(r.data?.streak_days) }
  if (r.code === ALREADY) return { outcome: "done", ...(await earlier(site, a)) }
  const why = r.msg || (r.code ? `error ${r.code}` : statusText(r.status))
  return { outcome: CAPTCHA.test(why) ? "captcha" : "failed", message: why }
}

// what today's press gave and the streak, when WorkBuddy will say; a card without them is still right
async function earlier(site, a) {
  try {
    const s = await postMeter(site, a, ACTIVITY)
    if (s.code === 0) return { credit: count(s.data?.today_credit), streak: count(s.data?.streak_days) }
  } catch {}
  return { credit: 0, streak: 0 }
}
