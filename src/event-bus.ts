import { EventEmitter } from "node:events";

/**
 * Typed event emitted by the global EventBus for every run/node lifecycle transition.
 */
export type RunEvent = {
  event:
    | "run.started"
    | "run.completed"
    | "run.errored"
    | "node.started"
    | "node.completed"
    | "node.errored";
  runId: string;
  pipelineId: string;
  status: string;
  nodeId?: string;
  timestamp: number;
};

/**
 * In-process singleton event bus for broadcasting pipeline run lifecycle events.
 *
 * Consumers subscribe via `EventBus.getInstance().on("run-event", cb)`.
 * The DeterministicRunner emits to this bus alongside its existing per-instance
 * EventEmitter events and store.save() calls.
 */
export class EventBus extends EventEmitter {
  private static instance: EventBus | undefined;

  private constructor() {
    super();
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Emit a typed RunEvent on the "run-event" channel.
   */
  emitRunEvent(event: RunEvent): void {
    this.emit("run-event", event);
  }

  /**
   * Reset the singleton (for testing only).
   */
  static resetForTesting(): void {
    if (EventBus.instance) {
      EventBus.instance.removeAllListeners();
      EventBus.instance = undefined;
    }
  }
}
