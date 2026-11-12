// The settings view and the migration of a v1 copy's options. The rules live in storage (`rules`: a list of
// { id, from, to }; `keepUpstreamName`: a boolean) and gateway.js reads them through ctx.shared.

import { definePlugin, storage, ui, t } from "astra"
import { CrudTable } from "@astragate/plugin-sdk/patterns"
import { fromV1Options, parsePattern } from "./rules.js"

const closed = { open: false }

// fills the sheet's two fields; `draft` keeps what an edited row held so the fields start with it
const form = (draft) => [
  ui.Field({ label: t("from.label"), hint: t("from.hint"), required: true }, ui.TextField({ name: "from", value: draft.from, placeholder: "fast  |  /^claude-(.*)$/" })),
  ui.Field({ label: t("to.label"), hint: t("to.hint"), required: true }, ui.TextField({ name: "to", value: draft.to, placeholder: "deepseek-chat  |  glm-$1" })),
]

export const settings = ui.defineView({
  init: async () => ({
    rules: (await storage.get("rules")) ?? [],
    keepUpstreamName: (await storage.get("keepUpstreamName")) === true,
    sheet: closed,
  }),
  render: (s) =>
    ui.Stack({ gap: "4" }, [
      ui.Section({ title: t("title"), description: t("description") }, [
        ui.Row({ label: t("keep.label"), detail: t("keep.hint") }, [
          ui.Switch({ name: "keepUpstreamName", checked: s.keepUpstreamName, onChange: "setKeep" }),
        ]),
      ]),
      CrudTable({
        title: t("rules.title"),
        description: t("rules.description"),
        columns: [
          { key: "from", title: t("from.label") },
          { key: "kind", title: t("kind.label") },
          { key: "to", title: t("to.label") },
        ],
        rows: s.rules.map((r) => ({ ...r, kind: parsePattern(r.from) ? t("kind.pattern") : t("kind.exact") })),
        rowKey: "id",
        createAction: "create",
        editAction: "edit",
        saveAction: "save",
        closeAction: "close",
        deleteAction: "remove",
        labels: { create: t("add"), edit: t("edit"), delete: t("delete"), confirmDelete: t("delete.confirm"), cancel: t("cancel"), save: t("save"), empty: t("empty") },
        sheet: { ...s.sheet, content: s.sheet.open ? form(s.sheet.draft ?? {}) : undefined },
      }),
    ]),
  actions: {
    setKeep: async (s, args) => {
      s.keepUpstreamName = args.value === true
      await storage.set("keepUpstreamName", s.keepUpstreamName)
    },
    create: (s) => void (s.sheet = { open: true, mode: "create", draft: {} }),
    edit: (s, args) => {
      const row = s.rules.find((r) => r.id === args.key)
      if (row) s.sheet = { open: true, mode: "edit", key: row.id, draft: { from: row.from, to: row.to } }
    },
    close: (s) => void (s.sheet = closed),
    save: async (s, _args, ctx) => {
      const from = String(ctx.local.from ?? "").trim()
      const to = String(ctx.local.to ?? "").trim()
      const errors = {}
      if (!from) errors.from = t("error.from.empty")
      else {
        try {
          parsePattern(from)
        } catch {
          errors.from = t("error.from.regex")
        }
        if (!errors.from && s.rules.some((r) => r.from === from && r.id !== s.sheet.key)) errors.from = t("error.from.duplicate")
      }
      if (!to) errors.to = t("error.to.empty")
      if (Object.keys(errors).length) return void ctx.fail(errors)
      if (s.sheet.mode === "edit") {
        const row = s.rules.find((r) => r.id === s.sheet.key)
        if (row) Object.assign(row, { from, to })
      } else {
        const id = "r" + Date.now().toString(36) + s.rules.length
        s.rules.push({ id, from, to })
      }
      await storage.set("rules", s.rules)
      s.sheet = closed
    },
    remove: async (s, args) => {
      s.rules = s.rules.filter((r) => r.id !== args.key)
      await storage.set("rules", s.rules)
      s.sheet = closed
    },
  },
})

export default definePlugin({
  async activate(ctx) {
    // Astra upgrading an installed v1 copy hands over its options once; they become rules, unless some already exist
    const from = ctx.upgrade?.from
    if (from && (await storage.get("rules")) == null) {
      const { rules, keepUpstreamName } = fromV1Options(from.options)
      await storage.set("rules", rules)
      await storage.set("keepUpstreamName", keepUpstreamName)
    }
  },
})
