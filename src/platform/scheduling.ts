/**
 * SchedulingFacade — the platform's scheduling surface: a thin, honest
 * wrapper over the ReminderScheduler, TaskScheduler and HeartbeatService
 * handles. Delegation only; starting/stopping stays the starter's call.
 *
 * Phase 10: digests sit behind this facade too — `digests` is the
 * DigestSchedulingService (morning + group digest scheduling, the ONE
 * implementation every surface calls). Optional in the handles so tests
 * and partial embeddings can build the facade without a storage-backed
 * digest service; bootstrap always wires it.
 */
import type { HeartbeatService } from "../autonomy/heartbeat";
import type { ReminderScheduler, TaskScheduler } from "../scheduler/scheduler";
import type { DigestSchedulingService } from "../digest/scheduling";

export interface SchedulingHandles {
  reminders: ReminderScheduler;
  tasks: TaskScheduler;
  heartbeat: HeartbeatService;
  digests?: DigestSchedulingService;
}

export class SchedulingFacade {
  readonly reminders: ReminderScheduler;
  readonly tasks: TaskScheduler;
  readonly heartbeat: HeartbeatService;
  /** Digest scheduling (Phase 10); undefined only in partial embeddings. */
  readonly digests: DigestSchedulingService | undefined;

  constructor(handles: SchedulingHandles) {
    this.reminders = handles.reminders;
    this.tasks = handles.tasks;
    this.heartbeat = handles.heartbeat;
    this.digests = handles.digests;
  }

  get reminderHandle(): ReminderScheduler {
    return this.reminders;
  }

  get taskHandle(): TaskScheduler {
    return this.tasks;
  }

  get heartbeatHandle(): HeartbeatService {
    return this.heartbeat;
  }
}
