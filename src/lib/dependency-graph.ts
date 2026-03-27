/**
 * DependencyGraph — builds an adjacency list from Idea[] and exposes
 * helpers for transitive-block counting, blocked status, cycle detection,
 * and effective-priority computation.
 */

export interface Idea {
  id: string;
  /** IDs of ideas that must be completed before this one. */
  blockedBy?: string[];
  /** Raw priority score (higher = more important). */
  priority?: number;
  /** Lifecycle status. */
  status?: string;
}

export class DependencyGraph {
  /** id → set of ideas it directly blocks (i.e. dependents / downstream). */
  private dependents = new Map<string, Set<string>>();
  /** id → set of ideas it is blocked by (i.e. dependencies / upstream). */
  private dependencies = new Map<string, Set<string>>();
  /** Quick status lookup. */
  private statusMap = new Map<string, string>();
  /** Quick priority lookup. */
  private priorityMap = new Map<string, number>();
  /** All known node ids. */
  private nodeIds = new Set<string>();

  constructor(ideas: Idea[]) {
    // Register every idea as a node.
    for (const idea of ideas) {
      this.nodeIds.add(idea.id);
      this.dependents.set(idea.id, this.dependents.get(idea.id) ?? new Set());
      this.dependencies.set(idea.id, new Set());
      this.statusMap.set(idea.id, idea.status ?? "open");
      this.priorityMap.set(idea.id, idea.priority ?? 0);
    }

    // Build adjacency lists.
    for (const idea of ideas) {
      if (!idea.blockedBy) continue;
      for (const upstreamId of idea.blockedBy) {
        // Ensure upstream node exists in the graph even if not in the array.
        if (!this.dependents.has(upstreamId)) {
          this.dependents.set(upstreamId, new Set());
          this.nodeIds.add(upstreamId);
        }
        this.dependents.get(upstreamId)!.add(idea.id);
        this.dependencies.get(idea.id)!.add(upstreamId);
      }
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Number of ideas transitively blocked by the given id
   * (i.e. how many downstream nodes depend on it, directly or indirectly).
   */
  transitiveBlockCount(id: string): number {
    const visited = new Set<string>();
    const queue: string[] = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const children = this.dependents.get(current);
      if (!children) continue;
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }
    return visited.size;
  }

  /**
   * True if any upstream (blockedBy) idea has a status other than
   * "done" or "built".
   */
  isBlocked(id: string): boolean {
    const deps = this.dependencies.get(id);
    if (!deps) return false;
    for (const depId of deps) {
      const status = this.statusMap.get(depId) ?? "open";
      if (status !== "done" && status !== "built") {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if adding an edge fromId → toId (meaning toId becomes
   * blocked by fromId) would create a cycle.
   *
   * A cycle exists if toId can already reach fromId through existing edges
   * (i.e. fromId is transitively blocked by toId).
   */
  wouldCreateCycle(fromId: string, toId: string): boolean {
    if (fromId === toId) return true;

    // If we add edge "toId is blockedBy fromId", that means fromId → toId
    // in the dependents direction.  A cycle exists if toId can already reach
    // fromId via the dependents graph (toId is an ancestor of fromId).
    const visited = new Set<string>();
    const queue: string[] = [toId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const children = this.dependents.get(current);
      if (!children) continue;
      for (const child of children) {
        if (child === fromId) return true;
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }
    return false;
  }

  /**
   * effectivePriority = rawPriority + boostFactor * transitiveBlockCount
   */
  computeEffectivePriority(id: string, boostFactor: number): number {
    const raw = this.priorityMap.get(id) ?? 0;
    return raw + boostFactor * this.transitiveBlockCount(id);
  }
}
