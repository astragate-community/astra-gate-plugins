// The settings view, and the migration of a v1 copy's options. Everything lives in storage under "settings";
// gateway.js reads it through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { normalize, fromV1Options } from "./settings.js"
import { CLI_VERSION } from "./identity.js"

// literal keys, so the validator can see each one
const protocolOptions = () => [
  { value: "anthropic", label: t("protocol.anthropic") },
  { value: "chat", label: t("protocol.chat") },
  { value: "any", label: t("protocol.any") },
]

const on = (field) => ({ action: "set", args: { field } })

export const settings = ui.defineView({
  init: async () => normalize(await storage.get("settings")),
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Alert({ tone: "warning", title: t("risk.title"), message: t("risk.message") }),
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("providers.label"), hint: t("providers.hint") },
            ui.TagInput({ name: "providers", value: s.providers, onChange: on("providers"), a11yLabel: t("providers.label") })),
          ui.Field({ label: t("protocol.label"), hint: t("protocol.hint") },
            ui.Select({ name: "protocol", value: s.protocol, onChange: on("protocol"), options: protocolOptions(), a11yLabel: t("protocol.label") })),
          ui.Field({ label: t("version.label"), hint: t("version.hint", { version: CLI_VERSION }) },
            ui.TextField({ name: "version", value: s.version, placeholder: CLI_VERSION, pattern: "\\d+\\.\\d+\\.\\d+", onChange: on("version"), a11yLabel: t("version.label") })),
          ui.Field({ label: t("betas.label"), hint: t("betas.hint") },
            ui.TextField({ name: "betas", value: s.betas, onChange: on("betas"), a11yLabel: t("betas.label") })),
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
