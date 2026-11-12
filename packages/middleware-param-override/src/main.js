// The settings view, and the migration of a v1 copy's options. Everything lives in storage under "settings";
// gateway.js reads it through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { normalize, fromV1Options, parse } from "./settings.js"

const EXAMPLE = `{
  "operations": [
    { "path": "max_tokens", "mode": "set", "value": 32000,
      "conditions": [{ "path": "max_tokens", "mode": "gt", "value": 32000 }] },
    { "path": "temperature", "mode": "delete",
      "conditions": [{ "path": "model", "mode": "contains", "value": "reasoner" }] }
  ]
}`

export const settings = ui.defineView({
  // `error` is what the last edit got wrong; the text shown is then the draft, not what is saved
  init: async () => {
    const s = normalize(await storage.get("settings"))
    return { ...s, draft: s.text, error: null }
  },
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("json.label"), hint: t("json.hint"), error: s.error ?? undefined },
            ui.CodeField({ name: "text", value: s.draft, language: "json", rows: 18, validate: true, onChange: "setText", a11yLabel: t("json.label") })),
          ui.Row({ label: t("example.label"), detail: t("example.hint") }, [
            ui.Button({ label: t("example.use"), variant: "secondary", onPress: "useExample" }),
          ]),
        ]),
      ]),
    ]),
  actions: {
    // saved as it is typed, as long as it is a JSON object; otherwise the previous good version keeps running
    setText: async (s, args) => save(s, String(args.value ?? "")),
    useExample: async (s) => save(s, EXAMPLE),
  },
})

async function save(s, text) {
  s.draft = text
  const parsed = parse(text)
  if (parsed.error !== undefined) {
    s.error = parsed.error === "object" ? t("error.object") : t("error.json", { message: parsed.error })
    return
  }
  s.error = null
  s.text = text
  s.config = parsed.config
  await storage.set("settings", { text, config: parsed.config })
}

export default definePlugin({
  async activate(ctx) {
    // Astra upgrading an installed v1 copy hands over its options once; they become the settings, unless some exist
    const from = ctx.upgrade?.from
    if (from && (await storage.get("settings")) == null) await storage.set("settings", fromV1Options(from.options))
  },
})
