/**
 * computeDependencyWaves — Kahn's algorithm to group stories into
 * parallel-execution waves based on their dependency edges.
 */

export interface Story {
  id: string;
  /** IDs of stories that must complete before this one can start. */
  dependsOn?: string[];
  /** Optional ordering hint (unused by the algorithm but preserved). */
  order?: number;
}

export interface ComputeWavesOptions {
  /**
   * If set, large waves are split into sub-waves of at most this size.
   * Must be a positive integer.
   */
  maxPerWave?: number;
}

/**
 * Groups stories into dependency waves using Kahn's topological-sort algorithm.
 *
 * Stories whose dependencies are all satisfied appear in the earliest possible
 * wave. Within each wave, stories are sorted by their `order` field (ascending)
 * so the output is deterministic.
 *
 * @returns An ordered array of waves, where each wave is a Story[].
 * @throws If any `dependsOn` ID references a story not in the input array.
 * @throws If the dependency graph contains a cycle.
 */
export function computeDependencyWaves(
  stories: Story[],
  options: ComputeWavesOptions = {},
): Story[][] {
  const { maxPerWave } = options;

  if (maxPerWave !== undefined && (maxPerWave < 1 || !Number.isInteger(maxPerWave))) {
    throw new Error("maxPerWave must be a positive integer");
  }

  if (stories.length === 0) return [];

  // ── Build lookup and validate references ──────────────────
  const storyById = new Map<string, Story>();
  for (const story of stories) {
    storyById.set(story.id, story);
  }

  for (const story of stories) {
    if (!story.dependsOn) continue;
    for (const depId of story.dependsOn) {
      if (!storyById.has(depId)) {
        throw new Error(
          `Story "${story.id}" depends on "${depId}", which does not exist`,
        );
      }
    }
  }

  // ── Kahn's algorithm ──────────────────────────────────────
  // in-degree: number of unsatisfied dependencies per story
  const inDegree = new Map<string, number>();
  // dependents: story → list of stories it unblocks when completed
  const dependents = new Map<string, string[]>();

  for (const story of stories) {
    inDegree.set(story.id, story.dependsOn?.length ?? 0);
    dependents.set(story.id, []);
  }

  for (const story of stories) {
    if (!story.dependsOn) continue;
    for (const depId of story.dependsOn) {
      dependents.get(depId)!.push(story.id);
    }
  }

  const waves: Story[][] = [];
  // Seed with all zero-indegree stories
  let currentIds = stories
    .filter((s) => inDegree.get(s.id) === 0)
    .map((s) => s.id);

  let processed = 0;

  while (currentIds.length > 0) {
    // Sort deterministically by order then id
    const wave = currentIds
      .map((id) => storyById.get(id)!)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

    waves.push(wave);
    processed += wave.length;

    const nextIds: string[] = [];
    for (const story of wave) {
      for (const depId of dependents.get(story.id)!) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          nextIds.push(depId);
        }
      }
    }
    currentIds = nextIds;
  }

  // ── Cycle detection ───────────────────────────────────────
  if (processed < stories.length) {
    const cycleIds = stories
      .filter((s) => inDegree.get(s.id)! > 0)
      .map((s) => s.id);
    throw new Error(
      `Dependency cycle detected among stories: ${cycleIds.join(", ")}`,
    );
  }

  // ── Optional sub-wave splitting ───────────────────────────
  if (maxPerWave) {
    const split: Story[][] = [];
    for (const wave of waves) {
      for (let i = 0; i < wave.length; i += maxPerWave) {
        split.push(wave.slice(i, i + maxPerWave));
      }
    }
    return split;
  }

  return waves;
}
