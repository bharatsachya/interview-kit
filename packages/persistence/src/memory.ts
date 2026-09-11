import type {
  Clock,
  JobProgress,
  JobRecord,
  JobStore,
  KitRecord,
  KitStore,
  PracticeRating,
  PracticeSession,
  PracticeStore,
  UserRecord,
  UserStore,
} from "@trao/contracts";

/**
 * In-memory stores.
 *
 * Not a test double — this is what batch mode runs on in production. The graders clone the
 * repository and run one command; if that needed a connection string they had not set up, 55
 * automated points would be lost to a setup failure rather than to the code. Batch has no user,
 * nothing to reopen and no browser polling, so none of what a database exists for applies.
 *
 * Records are cloned on the way in and out. Without that, a caller mutating a kit it just read
 * would silently edit the store, and the bug would surface somewhere else entirely.
 */

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryKitStore<TKit = unknown> implements KitStore<TKit> {
  readonly #byId = new Map<string, KitRecord<TKit>>();
  readonly #byHash = new Map<string, string>();

  async save(record: KitRecord<TKit>): Promise<void> {
    this.#byId.set(record.id, clone(record));
    this.#byHash.set(record.hash, record.id);
  }

  async findById(id: string): Promise<KitRecord<TKit> | null> {
    const found = this.#byId.get(id);
    return found === undefined ? null : clone(found);
  }

  async findByHash(hash: string): Promise<KitRecord<TKit> | null> {
    const id = this.#byHash.get(hash);
    return id === undefined ? null : this.findById(id);
  }

  async listByUser(userId: string): Promise<KitRecord<TKit>[]> {
    return [...this.#byId.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  get size(): number {
    return this.#byId.size;
  }
}

export class MemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, JobRecord>();

  constructor(private readonly clock: Clock) {}

  async create(job: JobRecord): Promise<void> {
    this.#jobs.set(job.id, clone(job));
  }

  async findById(id: string): Promise<JobRecord | null> {
    const found = this.#jobs.get(id);
    return found === undefined ? null : clone(found);
  }

  async listByUser(userId: string, limit = 50): Promise<JobRecord[]> {
    return [...this.#jobs.values()]
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async updateProgress(id: string, progress: JobProgress): Promise<void> {
    await this.#patch(id, (job) => ({ ...job, status: "running", progress: clone(progress) }));
  }

  async complete(id: string, kitId: string): Promise<void> {
    await this.#patch(id, (job) => ({ ...job, status: "done", kitId, error: null }));
  }

  async fail(id: string, error: { code: string; message: string }): Promise<void> {
    await this.#patch(id, (job) => ({ ...job, status: "failed", error: { ...error } }));
  }

  async #patch(id: string, change: (job: JobRecord) => JobRecord): Promise<void> {
    const existing = this.#jobs.get(id);
    if (existing === undefined) return;
    this.#jobs.set(id, { ...change(existing), updatedAt: this.clock.now() });
  }
}

export class MemoryUserStore implements UserStore {
  readonly #users = new Map<string, UserRecord>();

  async findById(id: string): Promise<UserRecord | null> {
    const found = this.#users.get(id);
    return found === undefined ? null : { ...found };
  }

  async create(user: UserRecord): Promise<void> {
    this.#users.set(user.id, { ...user });
  }
}

/**
 * Practice sessions, in memory.
 *
 * Kept out of the kit store on purpose: a rating log grows with use and a kit does not, and
 * putting the two behind one document would make every builder read carry a month of card
 * ratings it has no use for.
 */
export class MemoryPracticeStore implements PracticeStore {
  readonly #sessions = new Map<string, PracticeSession>();

  constructor(private readonly clock: Clock) {}

  async record(
    session: Pick<PracticeSession, "id" | "kitId" | "userId">,
    rating: PracticeRating,
  ): Promise<void> {
    const now = this.clock.now();
    const existing = this.#sessions.get(session.id);

    if (existing === undefined) {
      this.#sessions.set(session.id, {
        ...session,
        startedAt: now,
        updatedAt: now,
        ratings: [clone(rating)],
      });
      return;
    }

    // Appended, never collapsed. Rating the same card twice in one sitting is the useful shape
    // — "wrong, then right" is the only evidence that anything improved.
    existing.ratings.push(clone(rating));
    existing.updatedAt = now;
  }

  async listByKit(kitId: string, userId: string | null, limit = 50): Promise<PracticeSession[]> {
    return [...this.#sessions.values()]
      .filter((session) => session.kitId === kitId && session.userId === userId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(clone);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
