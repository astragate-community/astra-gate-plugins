// Factory: the plan's usage — GET /api/billing/limits, as droid's /status asks it.
import { factoryGet } from "./api.js";
import { FactoryStatus } from "./errors.js";
import { limitWindows } from "./usage-windows.js";
import { fresh, repair } from "./session.js";

/** The account's limits as windows, asked once more when Factory refused an org that was put right. */
export async function readUsage(account) {
  const limits = async () => factoryGet(await fresh(account), "/api/billing/limits", 15_000);
  let l;
  try {
    try {
      l = await limits();
    } catch (e) {
      if (!(e instanceof FactoryStatus && e.code === 403 && (await repair(account).catch(() => undefined)))) throw e;
      l = await limits();
    }
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
  if (!l?.limits?.standard) return { error: "Factory: the account reported no limits" };
  const windows = limitWindows(l);
  const main = windows.find((w) => !w.aside && !w.display) ?? windows[0];
  return { windows, used: main ? main.used / 100 : 0, label: main ? `${Math.round(main.used)}%` : "" };
}
