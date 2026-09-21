/**
 * Serialised, coalescing task runner for the studio.
 *
 * The studio shells out to the *same* `scripts/build-manifest.ts` that CI runs,
 * so a preview can never disagree with the deployed build. Subprocesses are
 * expensive and mutate a shared output directory, so they must not overlap:
 * this queue runs strictly one at a time and merges concurrent requests into a
 * single follow-up run rather than queueing a run per upload.
 */

export interface QueueRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** ms spent in the subprocess. */
  ms: number;
}

export type TaskRunner = () => Promise<QueueRunResult>;

export interface QueueState {
  running: boolean;
  /** How many requests are waiting for (or merged into) a run. */
  queued: number;
  /** Increments on every completed run. */
  generation: number;
  last?: QueueRunResult;
}

export class SerialTaskQueue {
  #running = false;
  #pending = 0;
  #generation = 0;
  #last: QueueRunResult | undefined;
  #runner: TaskRunner;
  #waiters: ((result: QueueRunResult) => void)[] = [];

  constructor(runner: TaskRunner) {
    this.#runner = runner;
  }

  get state(): QueueState {
    return {
      running: this.#running,
      queued: this.#pending,
      generation: this.#generation,
      ...(this.#last ? { last: this.#last } : {}),
    };
  }

  /** Resolves when the next run (which includes this request) completes. */
  request(): Promise<QueueRunResult> {
    this.#pending += 1;
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#pending === 0) return;
    this.#running = true;

    // Take everyone currently waiting: they all get this run's result.
    const waiters = this.#waiters;
    this.#waiters = [];
    this.#pending = Math.max(0, this.#pending - waiters.length);

    let result: QueueRunResult;
    try {
      result = await this.#runner();
    } catch (error) {
      result = {
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        ms: 0,
      };
    }
    this.#last = result;
    this.#generation += 1;
    this.#running = false;

    for (const waiter of waiters) waiter(result);
    void this.#drain();
  }
}
