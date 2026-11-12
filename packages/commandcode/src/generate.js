// The Go plan's only endpoint, /alpha/generate: a chat completion shaped the way the CLI asks it (the request), and its reply
// (a JSON object a line) turned back into chat completion chunks (reply.js).
import { crypto, env } from 'astra';
import { CLI_VERSION, MAX_TOKENS } from './constants.js';
import { TABLE } from './catalog.js';

const GO_EFFORTS = Object.fromEntries(TABLE.map((m) => [m.id, m.efforts ?? []]));
export const randomHex = (n) => crypto.randomUUID().replaceAll('-', '').slice(0, n);
const SESSION = crypto.randomUUID(); // one x-session-id for as long as this runs, as one CLI session has
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** A message's text: a string, or the text parts of an array. */
export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((p) => p?.type === 'text')
          .map((p) => p.text ?? '')
          .join('')
      : '';

/** The level the model has nearest the one asked, the higher on a tie. */
export function fitEffort(want, levels) {
  if (want === 'ultra' && !levels.includes(want)) want = 'max';
  if (!levels.length || levels.includes(want)) return want;
  const at = EFFORT_RANK.indexOf(want);
  if (at < 0) return want;
  let best = want;
  let dist = EFFORT_RANK.length;
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l);
    if (i < 0 || l === 'none') continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d];
  }
  return best;
}

function imagePart(p) {
  const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
  if (!u) return null;
  const m = /^data:([^;,]+)[;,]/.exec(u);
  return m ? { type: 'image', image: u, mimeType: m[1] } : { type: 'image', image: u };
}

/** A tool call's arguments, a JSON string or an object, as an object. */
export function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const WORK_DIR = 'x-magpie-work-dir';
const WORK_GIT = 'x-magpie-work-git';

/** Where the agent works, as magpie says it in WORK_DIR (percent-encoded) and WORK_GIT ("yes" / "no"): {dir?, git?}. Headers are lower-cased. */
export function workPlace(h = {}) {
  const place = {};
  if (h[WORK_DIR]) {
    try {
      place.dir = decodeURIComponent(h[WORK_DIR]);
    } catch {
      // an unreadable folder is no folder
    }
  }
  if (place.dir && (h[WORK_GIT] === 'yes' || h[WORK_GIT] === 'no')) place.git = h[WORK_GIT];
  return place;
}

/**
 * A chat completion request as the CLI asks /alpha/generate, with no structure, branch or status behind it. The working directory
 * and whether it is a git repository are the agent's as magpie tells them (`place`); untold, the CLI's config outside a git
 * repository, with the folder "~" (a plugin cannot read the user's home folder).
 */
export function generateBody(chat, place = {}) {
  const system = [];
  const messages = [];
  const names = {}; // a tool call's id → its tool
  let results = null;
  const flush = () => {
    if (results?.length) messages.push({ role: 'tool', content: results });
    results = null;
  };
  for (const m of chat.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      results ??= [];
      results.push({ type: 'tool-result', toolCallId: m.tool_call_id, toolName: names[m.tool_call_id] || 'unknown', output: { type: 'text', value: textOf(m.content) } });
      continue;
    }
    flush();
    if (m.role === 'assistant') {
      const parts = [];
      const thought = m.reasoning_content ?? m.reasoning;
      if (typeof thought === 'string' && thought) parts.push({ type: 'reasoning', text: thought });
      const t = textOf(m.content);
      if (t) parts.push({ type: 'text', text: t });
      for (const c of m.tool_calls ?? []) {
        names[c.id] = c.function?.name;
        parts.push({ type: 'tool-call', toolCallId: c.id, toolName: c.function?.name, input: parseArgs(c.function?.arguments) });
      }
      if (parts.length) messages.push({ role: 'assistant', content: parts });
      continue;
    }
    const parts = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ type: 'text', text: m.content });
    } else
      for (const p of m.content ?? []) {
        if (p?.type === 'text' && p.text) parts.push({ type: 'text', text: p.text });
        else if (p?.type === 'image_url') {
          const im = imagePart(p);
          if (im) parts.push(im);
        }
      }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }
  flush();
  const tools = (chat.tools ?? [])
    .filter((t) => t?.type === 'function' && t.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  const params = { model: chat.model, messages, tools, system: system.join('\n\n'), max_tokens: chat.max_completion_tokens || chat.max_tokens || MAX_TOKENS, stream: true };
  if (typeof chat.temperature === 'number') params.temperature = chat.temperature;
  const effort = chat.reasoning_effort;
  if (effort && effort !== 'none') params.reasoning_effort = fitEffort(effort, GO_EFFORTS[chat.model] ?? []);
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    config: { workingDir: place.dir || '~', date, environment: env.platform, structure: [], isGitRepo: place.git === 'yes', currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    params,
  };
}

/** The CLI's own headers (buildCommandAuthHeaders). */
export const generateHeaders = (key) => ({
  'Content-Type': 'application/json',
  'User-Agent': 'cli',
  'x-command-code-version': CLI_VERSION,
  'x-cli-environment': 'production',
  'x-project-slug': 'magpie',
  'x-taste-learning': 'false',
  'x-session-id': SESSION,
  Authorization: `Bearer ${key}`,
});
