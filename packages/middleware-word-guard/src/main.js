// The settings view, and the migration of a v1 copy's options. Everything lives in storage under "settings";
// gateway.js reads it through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { normalize, fromV1Options, badPattern } from "./settings.js"

const on = (field) => ({ action: "set", args: { field } })

export const settings = ui.defineView({
  init: async () => ({ ...normalize(await storage.get("settings")), error: null }),
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("words.label"), hint: t("words.hint") },
            ui.TagInput({ name: "words", value: s.words, onChange: on("words"), a11yLabel: t("words.label") })),
          ui.Field({ label: t("patterns.label"), hint: t("patterns.hint"), error: s.error ?? undefined },
            ui.TagInput({ name: "patterns", value: s.patterns, onChange: on("patterns"), a11yLabel: t("patterns.label") })),
        ]),
      ]),
      ui.Section({ title: t("action.title") }, [
        ui.Stack({ gap: "3" }, [
          ui.Field({ label: t("action.label"), hint: t("action.hint") },
            ui.Segmented({ name: "action", value: s.action, onChange: on("action"), options: [{ value: "reject", label: t("action.reject") }, { value: "mask", label: t("action.mask") }] })),
          ui.Field({ label: t("message.label"), hint: t("message.hint") },
            ui.TextField({ name: "message", value: s.message, onChange: on("message"), a11yLabel: t("message.label") })),
          ui.Field({ label: t("mask.label"), hint: t("mask.hint") },
            ui.TextField({ name: "mask", value: s.mask, onChange: on("mask"), a11yLabel: t("mask.label") })),
          ui.Field({ label: t("check.label"), hint: t("check.hint") },
            ui.Segmented({ name: "check", value: s.check, onChange: on("check"), options: [{ value: "last", label: t("check.last") }, { value: "all", label: t("check.all") }] })),
          ui.Row({ label: t("replies.label"), detail: t("replies.hint") }, [
            ui.Switch({ name: "replies", checked: s.replies, onChange: on("replies"), a11yLabel: t("replies.label") }),
          ]),
        ]),
      ]),
    ]),
  actions: {
    // every control saves as it changes; the value a control sends is cleaned by normalize like a stored one.
    // A pattern list with a bad expression is not saved: it would make the hook fail on every request.
    set: async (s, args) => {
      const next = normalize({ ...s, [args.field]: args.value })
      const bad = args.field === "patterns" ? badPattern(next.patterns) : null
      s.error = bad === null ? null : t("patterns.error", { pattern: bad })
      if (bad !== null) return
      Object.assign(s, next)
      await storage.set("settings", next)
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
