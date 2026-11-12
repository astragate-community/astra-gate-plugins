// The settings view, and the migration of a v1 copy's options. The mode lives in storage under "settings";
// gateway.js reads it through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { normalize, fromV1Options } from "./settings.js"

export const settings = ui.defineView({
  init: async () => normalize(await storage.get("settings")),
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Stack({ gap: "3" }, [
          ui.RadioCards({
            name: "mode",
            value: s.mode,
            onChange: "setMode",
            columns: 1,
            options: [
              { value: "strip", title: t("mode.strip"), description: t("mode.strip.hint") },
              { value: "to_content", title: t("mode.to_content"), description: t("mode.to_content.hint") },
            ],
          }),
        ]),
      ]),
    ]),
  actions: {
    setMode: async (s, args) => {
      Object.assign(s, normalize({ mode: args.value }))
      await storage.set("settings", { ...s })
    },
  },
})

export default definePlugin({
  async activate(ctx) {
    // Astra upgrading an installed v1 copy hands over its options once; they become the settings, unless some exist
    const from = ctx.upgrade?.from
    if (from && (await storage.get("settings")) == null) await storage.set("settings", fromV1Options(from.options))
  },
})
