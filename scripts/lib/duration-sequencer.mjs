// Vitest sequencer that cuts `--shard` by recorded duration, not file count.
//
// vitest 5's BaseSequencer.shard sorts the files by a hash of their path and
// hands each shard the same number of files, so one shard can draw most of
// the slow ones (integration on main: 447 s against 235 s). This overrides
// only shard(): the split comes from vitest.durations.json at the config root
// (see scripts/lib/test-durations.mjs for the format and the algorithm), and
// BaseSequencer.sort still orders the files inside a shard. A file missing
// from vitest.durations.json weighs its project's median, so a new test file
// never breaks the split; a missing or broken durations file degrades to
// near-equal file counts.
//
// Set at the root of vitest.config.ts (`test.sequence.sequencer`); vitest
// builds one per run as `new Sequencer(ctx)`.

import path from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { DURATIONS_FILE_NAME, balanceShards, readDurationsFile, toPosix } from './test-durations.mjs';

export class DurationSequencer extends BaseSequencer {
  /** The checked-in durations; a test overrides this. */
  loadDurations() {
    return readDurationsFile(path.join(this.ctx.config.root, DURATIONS_FILE_NAME));
  }

  async shard(files) {
    const { root, shard } = this.ctx.config;
    const items = files.map((spec) => ({
      spec,
      path: toPosix(path.relative(root, spec.moduleId)),
      project: spec.project.name,
      pool: spec.pool,
    }));
    const shards = balanceShards(items, this.loadDurations(), shard.count);
    // `index` is 1-based, as in BaseSequencer.calculateShardRange.
    return shards[shard.index - 1].map((item) => item.spec);
  }
}

export default DurationSequencer;
