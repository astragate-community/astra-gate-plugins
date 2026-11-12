// Trae: the model lists — which entries are models to chat with, which function and __dev / __max model asks for each,
// and the models as the provider lists them.
import { batchLists, listOf } from './api.js';
import { Expired } from './errors.js';
import { CONTEXT, MAX } from './sites.js';

// chatModel: an entry of a function's list that is a model to chat with. The lists also hold the IDE's own helpers
// (summary, fast_apply, title generation: usage other than chat_completion), configs switched off, and the slots of
// custom models, which need a provider bound in the IDE.
export function chatModel(m, site) {
  const id = String(m?.config_name ?? '');
  if (!id || /^custom_model/i.test(id)) return false;
  if (m.usage && m.usage !== 'chat_completion') return false;
  if (m.config_switch === false) return false;
  if (m.is_custom_model === true || m.display_config?.is_custom_model === true) return false;
  // the IDE's own picker hides these: Auto-mode routing channels and pay-as-you-go twins of another entry
  if (site?.hidesInvisible && m.is_invisible_to_user === true) return false;
  return true;
}

const details = (m) => (Array.isArray(m?.model_detail_list) ? m.model_detail_list : []);

// devModel is the model an entry serves requests with: its __dev one
export const devModel = (m) => details(m).find((d) => /__dev$/.test(String(d?.model_name ?? '')));

// maxModel is a model's Max mode, from the entries its lists give it: the first __max model one names, and the window
// context_window_tokens.max gives it, when that is bigger than dev's. A model with no __max, or no bigger window, has no Max.
export const maxModel = (...ms) => {
  const at = ms.find((m) => details(m).some((d) => /__max$/.test(String(d?.model_name ?? ''))));
  if (!at) return null;
  const d = details(at).find((d) => /__max$/.test(String(d?.model_name ?? '')));
  const first = (k) => [at, ...ms].map((m) => Number(m?.context_window_tokens?.[k]) || 0).find((n) => n > 0) || 0;
  const window = first('max');
  return window > first('dev') ? { name: String(d.model_name), most: Number(d.max_tokens) || 0, window, entry: at } : null;
};

const nameOf = (m) => String(m.display_config?.display_name || m.display_name || m.display_model_name || m.config_name);

// liveLists is every chat function's model list: from batch_get_detail_param; when that gives none, from
// get_detail_param, one function at a time. One function's list failing leaves the others'; all failing is the error.
export async function liveLists(a, site) {
  let lists = null;
  try {
    lists = await batchLists(a, site);
  } catch (e) {
    if (e instanceof Expired) throw e;
  }
  if (!lists) {
    // (settled by hand: the plugin engine has no Promise.allSettled guarantee)
    const got = await Promise.all(site.functions.map((fn) => listOf(a, site, fn).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))));
    const expired = got.find((g) => g.status === 'rejected' && g.reason instanceof Expired);
    if (expired) throw expired.reason;
    if (got.every((g) => g.status === 'rejected')) throw got[0].reason;
    lists = {};
    got.forEach((g, i) => {
      if (g.status === 'fulfilled') lists[site.functions[i]] = g.value;
    });
  }
  return lists;
}

// chooseModels is the account's model list out of the functions' lists: every chat function's, since SOLO lists models
// the classic IDE's chat_v3 doesn't. A model several functions list takes the entry that names a __dev model, isn't
// misnamed (chat_v3 once called deepseek-v4.1-flash by another's name) and carries the name most of its lists give it.
// Each choice is { id, m, fn, dev }, and, unless the lists have a "<id>-max" entry of their own, { max, maxFn }.
export function chooseModels(lists, site) {
  const names = new Map(); // id → the names its lists give it, and how many give each
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!chatModel(m, site)) continue;
      const id = String(m.config_name), name = nameOf(m);
      const by = names.get(id) ?? new Map();
      by.set(name, (by.get(name) ?? 0) + 1);
      names.set(id, by);
    }
  }
  const agreed = new Map(); // id → the name most of its lists give it, "" when they tie
  for (const [id, by] of names) {
    const top = Math.max(...by.values());
    const most = [...by].filter(([, n]) => n === top);
    agreed.set(id, most.length === 1 ? most[0][0] : '');
  }
  const misnamed = (fn, m) => {
    const id = String(m.config_name), name = nameOf(m);
    return names.get(id).size > 1 && (lists[fn] ?? []).some((o) => chatModel(o, site) && String(o.config_name) !== id && nameOf(o) === name);
  };
  const worth = (fn, m) => (devModel(m) ? 2 : 0) + (misnamed(fn, m) ? 0 : 1) + (nameOf(m) === agreed.get(String(m.config_name)) ? 1 : 0);
  const out = new Map();
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!chatModel(m, site)) continue;
      const id = String(m.config_name);
      const was = out.get(id);
      if (!was || worth(fn, m) > was.worth) out.set(id, { m, fn, worth: worth(fn, m) });
    }
  }
  const chosen = [];
  for (const [id, { m, fn }] of out) {
    const choice = { id, m, fn, dev: devModel(m) };
    chosen.push(choice);
    if (out.has(id + MAX)) continue;
    const plain = (e) => (nameOf(e.m) === agreed.get(id) ? 0 : 1);
    const entries = [{ m, fn }, ...site.functions.flatMap((f) => (lists[f] ?? []).filter((o) => o !== m && chatModel(o, site) && String(o.config_name) === id).map((o) => ({ m: o, fn: f })))].sort((a, b) => plain(a) - plain(b));
    choice.max = maxModel(...entries.map((e) => e.m));
    if (choice.max) choice.maxFn = entries.find((e) => e.m === choice.max.entry).fn;
  }
  return chosen;
}

// the site's own fallback list, as the provider lists models
export const fallbackModels = (site) => site.models.map((m) => ({ id: m.id, name: m.name, protocol: 'chat', context: m.context ?? CONTEXT, ...(m.output ? { output: m.output } : {}), reasoning: true, vision: false }));

// modelsOf is the models a live list makes: each, and its Max where it has one. A model of the fallback list keeps
// the limits it names where the live entry names none.
export function modelsOf(chosen, site) {
  const known = new Map(site.models.map((m) => [m.id, m]));
  const ids = new Set(chosen.map((c) => c.id));
  const out = [];
  for (const { id, m, max } of chosen) {
    const was = known.get(id) ?? {};
    const context = Number(m.context_window_tokens?.dev ?? m.context_window_size?.max?.[0] ?? m.context_window_size?.max ?? m.context_window_tokens?.max ?? m.prompt_max_tokens) || was.context || CONTEXT;
    const output = Number(devModel(m)?.max_tokens) || was.output || 0;
    const own = { id, name: nameOf(m) === id && was.name ? was.name : nameOf(m), protocol: 'chat', context, ...(output ? { output } : {}), reasoning: true, vision: false };
    out.push(own);
    // its Max, a model of its own: the window and output Max mode gives
    if (max && !ids.has(id + MAX)) out.push({ ...own, id: id + MAX, name: own.name + ' (Max)', context: max.window, ...((max.most || output) ? { output: max.most || output } : {}) });
  }
  return out;
}

// What is known of an account's models from the list last read, per realm: the function whose list has each model, the
// __dev (or __max) model it is asked as there, and the reply limit. Filled by a model list (`remember`), read by the
// chat request (`catalog`). Process memory only: a model it doesn't know is asked of the realm's functions in turn.
const catalogs = new Map();

export const catalog = (site) => {
  let c = catalogs.get(site.id);
  if (!c) catalogs.set(site.id, (c = { listedBy: new Map(), modelNames: new Map() }));
  return c;
};

export function remember(site, chosen) {
  const { listedBy, modelNames } = catalog(site);
  for (const { id, fn, dev, max, maxFn } of chosen) {
    listedBy.set(id, fn);
    if (dev) modelNames.set(id, { fn, name: dev.model_name, most: Number(dev.max_tokens) || 0 });
    else modelNames.delete(id);
    if (max === undefined) continue; // the lists have its Max entry of their own
    if (max) {
      listedBy.set(id + MAX, maxFn);
      modelNames.set(id + MAX, { fn: maxFn, name: max.name, most: max.most, max: { base: id, window: max.window } });
    } else {
      listedBy.delete(id + MAX);
      modelNames.delete(id + MAX);
    }
  }
  return chosen;
}
