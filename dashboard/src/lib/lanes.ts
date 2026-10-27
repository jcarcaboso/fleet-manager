/**
 * Stale-response protection and bounded polling, without any framework dependency (`useView` wires it to Vue's scope).
 *
 * - A `Visit` is one stay on a view: it ends when the component is unmounted (or its `key` changes).
 * - A `Lane` is a sequence of operations of which only the newest counts, like "the current load" or "the current save".
 *   `lane.begin()` aborts the previous operation, bumps a generation counter and returns a `Token`.
 * - A `Token` says whether its operation is still current. After every `await`, call `token.check()` (or wrap the promise
 *   in `token.guard`) so a superseded continuation throws `SupersededError` (silent) instead of committing state.
 * - `visit.poll()` runs a bounded poll that stops on its own limits and when the visit ends.
 */
import { isSilent, superseded } from './errors';

export interface Token {
  /** Aborted when this operation is superseded, cancelled, or the visit ends. Pass it to every API call. */
  readonly signal: AbortSignal;
  /** The lane's generation number when this operation began. */
  readonly generation: number;
  /** `true` while no newer operation began on the lane and the visit is alive. */
  isCurrent(): boolean;
  /** Throws `SupersededError` (silent) when `isCurrent()` is false. */
  check(): void;
  /** Resolves with `promise`'s value, or throws `SupersededError` when the token went stale meanwhile (even if the promise rejected). */
  guard<T>(promise: Promise<T>): Promise<T>;
}

export type PollStopReason = 'done' | 'timeout' | 'maxTicks' | 'stopped' | 'error';

export interface PollOptions<T> {
  /** Time between the end of one tick and the start of the next. */
  intervalMs: number;
  /** Total time budget. At the deadline the tick in flight is aborted, polling stops and `onTimeout` runs. */
  timeoutMs?: number;
  /** Stops after this many ticks. */
  maxTicks?: number;
  /** Run the first tick at once (default) or after `intervalMs`. */
  immediate?: boolean;
  /** Called with each tick's result while the poll is active. Return `true` to stop. */
  done?(result: T, token: Token): boolean | void;
  /** Called when a tick throws a non-silent error. Return `'stop'` to stop; by default polling continues. */
  onError?: (error: unknown) => 'stop' | void;
  onTimeout?: () => void;
  /** Called once when polling ends, whatever the reason. */
  onStop?: (reason: PollStopReason) => void;
}

export interface Poll {
  /** Stops the poll and aborts the tick in flight. Safe to call twice. */
  stop(): void;
  readonly active: boolean;
  readonly ticks: number;
}

export class Visit {
  private epoch = 0;
  private disposed = false;
  private controller = new AbortController();
  private readonly lanes = new Set<Lane>();
  private readonly polls = new Set<ActivePoll>();

  get alive(): boolean {
    return !this.disposed;
  }
  /** Aborted when the visit ends or restarts. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  /** A token for the visit itself: current until it ends or restarts. Use it to ask "is the user still here?" after a mutation. */
  token(): Token {
    return this.makeToken(this.controller, () => 0, 0);
  }
  lane(): Lane {
    const lane = new Lane(this);
    this.lanes.add(lane);
    return lane;
  }
  /** Ends the current visit (everything in flight is aborted, polls stop) and starts a new one: the view stays but its route key changed. */
  restart(): void {
    this.endAll();
    this.epoch++;
    this.controller = new AbortController();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endAll();
  }

  /** Starts a bounded poll. It ends when `done` returns true, at `timeoutMs` or `maxTicks`, when `stop()` is called, or when the visit ends. */
  poll<T>(tick: (token: Token) => Promise<T>, options: PollOptions<T>): Poll {
    const poll = new ActivePoll(this, tick, options as PollOptions<unknown>);
    if (this.disposed) {
      poll.stop();
      return poll;
    }
    this.polls.add(poll);
    poll.start();
    return poll;
  }
  /** @internal */
  forget(poll: ActivePoll): void {
    this.polls.delete(poll);
  }
  /** @internal */
  isAlive(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch;
  }
  /** @internal */
  currentEpoch(): number {
    return this.epoch;
  }

  /** @internal */
  makeToken(controller: AbortController, generationOf: () => number, generation: number, lane?: Lane): Token {
    const epoch = this.epoch;
    const isCurrent = (): boolean => this.isAlive(epoch) && !controller.signal.aborted && (lane ? generationOf() === generation : true);
    const token: Token = {
      signal: controller.signal,
      generation,
      isCurrent,
      check() {
        if (!isCurrent()) throw superseded();
      },
      async guard<T>(promise: Promise<T>): Promise<T> {
        let value: T;
        try {
          value = await promise;
        } catch (error) {
          if (!isCurrent()) throw superseded();
          throw error;
        }
        token.check();
        return value;
      },
    };
    return token;
  }

  private endAll(): void {
    this.controller.abort();
    for (const poll of [...this.polls]) poll.finish('stopped');
    for (const lane of this.lanes) lane.cancel();
  }
}

export class Lane {
  private generation = 0;
  private controller: AbortController | null = null;
  private latest: Token | null = null;

  constructor(private readonly visit: Visit) {}

  /** Starts a new operation: the previous one is aborted and stale, and this token is the only current one. */
  begin(): Token {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    if (!this.visit.alive) controller.abort();
    const generation = ++this.generation;
    this.latest = this.visit.makeToken(controller, () => this.generation, generation, this);
    return this.latest;
  }
  /** The newest token, or `null` before the first `begin` and after `cancel`. */
  current(): Token | null {
    return this.latest && this.latest.isCurrent() ? this.latest : null;
  }
  /** Aborts the operation in flight and makes its token stale without starting a new one. */
  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.latest = null;
  }
}

class ActivePoll implements Poll {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private _active = true;
  private _ticks = 0;
  private token: Token;

  constructor(private readonly visit: Visit, private readonly tick: (token: Token) => Promise<unknown>, private readonly options: PollOptions<unknown>) {
    this.token = visit.makeToken(this.controller, () => 0, 0);
  }
  get active(): boolean {
    return this._active;
  }
  get ticks(): number {
    return this._ticks;
  }
  start(): void {
    const { timeoutMs, intervalMs, immediate = true } = this.options;
    if (timeoutMs !== undefined) this.deadline = setTimeout(() => {
      if (!this._active) return;
      this.finish('timeout');
      this.options.onTimeout?.();
    }, timeoutMs);
    this.timer = setTimeout(() => void this.run(), immediate ? 0 : intervalMs);
  }
  stop(): void {
    this.finish('stopped');
  }
  finish(reason: PollStopReason): void {
    if (!this._active) return;
    this._active = false;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.timer = this.deadline = null;
    this.controller.abort();
    this.visit.forget(this);
    this.options.onStop?.(reason);
  }
  private async run(): Promise<void> {
    this.timer = null;
    if (!this._active) return;
    this._ticks++;
    let result: unknown;
    try {
      result = await this.tick(this.token);
    } catch (error) {
      if (!this._active) return;
      if (!isSilent(error) && this.options.onError?.(error) === 'stop') return this.finish('error');
      return this.next();
    }
    if (!this._active) return;
    if (this.options.done?.(result, this.token)) return this.finish('done');
    this.next();
  }
  private next(): void {
    if (!this._active) return;
    if (this.options.maxTicks !== undefined && this._ticks >= this.options.maxTicks) return this.finish('maxTicks');
    this.timer = setTimeout(() => void this.run(), this.options.intervalMs);
  }
}
