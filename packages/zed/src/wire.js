// What a provider's own stream events say, and how a failure looks in a stream already begun.

/** The Responses events that end a reply. */
export const RESPONSES_DONE = ['response.completed', 'response.incomplete', 'response.failed'];

/**
 * Whether one of the provider's own events says anything (text, reasoning, a call, a finish) rather than only framing the reply,
 * as magpie's decoders tell a reply begun from its lead (message_start, response.created, a role-only chunk).
 */
export function said(wire, ev) {
  if (!ev || typeof ev !== 'object') return true;
  switch (wire) {
    case 'anthropic':
      switch (ev.type) {
        case 'message_start':
        case 'ping':
        case 'content_block_stop':
          return false;
        case 'content_block_start':
          return !['text', 'thinking', 'redacted_thinking'].includes(ev.content_block?.type) || !!(ev.content_block?.text || ev.content_block?.thinking);
        case 'content_block_delta': {
          const d = ev.delta ?? {};
          return !(d.text === '' || d.thinking === '' || d.partial_json === '');
        }
      }
      return true;
    case 'responses':
      switch (ev.type) {
        case 'response.created':
        case 'response.in_progress':
        case 'response.queued':
        case 'response.content_part.added':
        case 'response.reasoning_summary_part.added':
          return false;
        case 'response.output_item.added':
          return !['message', 'reasoning'].includes(ev.item?.type);
        case 'response.output_text.delta':
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          return ev.delta !== '';
      }
      return true;
    case 'chat':
      if (ev.error) return true;
      if (!Array.isArray(ev.choices)) return false; // usage alone
      return ev.choices.some((c) => {
        const d = c?.delta ?? {};
        return !!(c?.finish_reason || d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length);
      });
    case 'gemini':
      if (ev.error) return true;
      return (ev.candidates ?? []).some((c) => c?.finishReason || (c?.content?.parts ?? []).some((p) => p?.text || p?.functionCall || p?.thought));
  }
  return true;
}

/** The message of an error the provider's own stream carries (Anthropic's error event, a failed response, a chat or Gemini chunk's error); undefined for any other event. */
export function eventError(wire, ev) {
  if (!ev || typeof ev !== 'object') return undefined;
  if (wire === 'anthropic' && ev.type === 'error') return String(ev.error?.message ?? '');
  if (wire === 'responses') {
    if (RESPONSES_DONE.includes(ev.type) && ev.response?.error) return String(ev.response.error.message ?? '');
    if (ev.type === 'error') return String((ev.error ? ev.error.message : ev.message) ?? '');
    return undefined;
  }
  if ((wire === 'chat' || wire === 'gemini') && ev.error) return String(ev.error?.message ?? '');
  return undefined;
}

/** One event as the host writes it: Anthropic and Responses stream `event:` lines, the others only data. */
export const out = (wire, ev) => ((wire === 'anthropic' || wire === 'responses') && ev?.type ? { event: ev.type, data: ev } : ev);
