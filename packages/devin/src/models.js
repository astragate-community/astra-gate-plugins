// Devin's models as the host's model records: every variant of every family as a model of its own (the v1 plugin offered a
// family with its efforts as variants; a v2 model record has none).
import { SNAPSHOT, SNAPSHOT_IMAGES } from './snapshot.js';

// the effort words Devin's variant ids end in (swe-2-high, ..._HIGH, gpt-6-sol-none), before an optional tier word
const EFFORT = /[-_](minimal|low|medium|high|xhigh|max)([-_](fast|priority))?$/i;

export function snapshotModels() {
  return SNAPSHOT.flatMap(([, , , variants]) =>
    variants.map(([id, name, context, output]) => ({
      id,
      name,
      protocol: 'chat',
      context,
      output,
      vision: SNAPSHOT_IMAGES[id] !== false,
      reasoning: EFFORT.test(id),
    })),
  );
}
