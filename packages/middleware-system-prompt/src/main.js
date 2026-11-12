// The settings view, and the migration of a v1 copy's options. Everything lives in storage under "settings";
// gateway.js reads it through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { normalize, fromV1Options } from "./settings.js"

const on = (field) => ({ action: "set", args: { field } })

export const settings = ui.defineView({
  init: async () => normalize(await storage.get("settings")),
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("prompt.label"), hint: t("prompt.hint") },
            ui.TextArea({ name: "prompt", value: s.prompt, rows: 6, autoGrow: true, onChange: on("prompt"), a11yLabel: t("prompt.label") })),
          ui.Row({ label: t("override.label"), detail: t("override.hint") }, [
            ui.Switch({ name: "override", checked: s.override, onChange: on("override"), a11yLabel: t("override.label") }),
          ]),
          ui.Field({ label: t("position.label"), hint: t("position.hint") },
            ui.Segmented({
              name: "position",
              value: s.position,
              onChange: on("position"),
              options: [{ value: "append", label: t("position.append") }, { value: "prepend", label: t("position.prepend") }],
            })),
        ]),
      ]),
      ui.Section({ title: t("filters.title"), description: t("filters.description") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("agents.label"), hint: t("agents.hint") },
            ui.TagInput({ name: "agents", value: s.agents, onChange: on("agents"), a11yLabel: t("agents.label") })),
          ui.Field({ label: t("models.label"), hint: t("models.hint") },
            ui.TagInput({ name: "models", value: s.models, onChange: on("models"), a11yLabel: t("models.label") })),
        ]),
      ]),
    ]),
  actions: {
    // every control saves as it changes; the value a control sends is cleaned by normalize like a stored one
    set: async (s, args) => {
      Object.assign(s, normalize({ ...s, [args.field]: args.value }))
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
