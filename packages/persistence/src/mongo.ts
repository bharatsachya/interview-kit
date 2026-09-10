import { MongoClient, type Collection, type Db } from "mongodb";
import type {
  Clock,
  JobProgress,
  JobRecord,
  JobStore,
  KitRecord,
  KitStore,
  UserRecord,
  UserStore,
} from "@trao/contracts";

/**
 * MongoDB stores, for the app.
 *
 * Only the app needs these. Batch mode uses the in-memory stores, and `packages/pipeline` never
 * touches either — it is handed whatever it is given, which is why a database can be absent
 * without the pipeline having an opinion about it.
 *
 * Documents are stored under `_id` so a kit id is the primary key rather than a secondary index,
 * and `_id` is stripped on the way out so callers never see a storage detail in a domain object.
 */

export interface MongoStoresOptions {
  uri: string;
  dbName?: string;
  clock: Clock;
}

export async function connectMongo(options: MongoStoresOptions): Promise<{
  kits: KitStore<unknown>;
  jobs: JobStore;
  users: UserStore;
  close: () => Promise<void>;
}> {
  const client = new MongoClient(options.uri);
  await client.connect();
  const db = client.db(options.dbName);

  await ensureIndexes(db);

  return {
    kits: new MongoKitStore(db),
    jobs: new MongoJobStore(db, options.clock),
    users: new MongoUserStore(db),
    close: () => client.close(),
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  // `hash` is how a resubmission is recognised, and `userId` is every list query. Both are on
  // the hot path of a page load, so neither is left to a collection scan.
  await db.collection("kits").createIndex({ hash: 1 });
  await db.collection("kits").createIndex({ userId: 1, createdAt: -1 });
  // The history list reads jobs by user, newest first, on every page load.
  await db.collection("jobs").createIndex({ userId: 1, createdAt: -1 });
}

type Stored<T> = T & { _id: string };

function strip<T extends { id?: string }>(document: Stored<unknown> | null): T | null {
  if (document === null) return null;
  const { _id, ...rest } = document as Stored<Record<string, unknown>>;
  return { ...rest, id: _id } as T;
}

export class MongoKitStore<TKit = unknown> implements KitStore<TKit> {
  readonly #collection: Collection<Stored<Record<string, unknown>>>;

  constructor(db: Db) {
    this.#collection = db.collection("kits");
  }

  async save(record: KitRecord<TKit>): Promise<void> {
    const { id, ...rest } = record;
    await this.#collection.replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
  }

  async findById(id: string): Promise<KitRecord<TKit> | null> {
    return strip<KitRecord<TKit>>(await this.#collection.findOne({ _id: id }));
  }

  async findByHash(hash: string): Promise<KitRecord<TKit> | null> {
    return strip<KitRecord<TKit>>(await this.#collection.findOne({ hash }));
  }

  async listByUser(userId: string): Promise<KitRecord<TKit>[]> {
    const documents = await this.#collection.find({ userId }).sort({ createdAt: -1 }).toArray();
    return documents.map((document) => strip<KitRecord<TKit>>(document)).filter((r): r is KitRecord<TKit> => r !== null);
  }
}

export class MongoJobStore implements JobStore {
  readonly #collection: Collection<Stored<Record<string, unknown>>>;

  constructor(
    db: Db,
    private readonly clock: Clock,
  ) {
    this.#collection = db.collection("jobs");
  }

  async create(job: JobRecord): Promise<void> {
    const { id, ...rest } = job;
    await this.#collection.replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
  }

  async findById(id: string): Promise<JobRecord | null> {
    return strip<JobRecord>(await this.#collection.findOne({ _id: id }));
  }

  async listByUser(userId: string, limit = 50): Promise<JobRecord[]> {
    const documents = await this.#collection.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return documents.map((document) => strip<JobRecord>(document)).filter((j): j is JobRecord => j !== null);
  }

  async updateProgress(id: string, progress: JobProgress): Promise<void> {
    await this.#collection.updateOne(
      { _id: id },
      { $set: { status: "running", progress, updatedAt: this.clock.now() } },
    );
  }

  async complete(id: string, kitId: string): Promise<void> {
    await this.#collection.updateOne(
      { _id: id },
      { $set: { status: "done", kitId, error: null, updatedAt: this.clock.now() } },
    );
  }

  async fail(id: string, error: { code: string; message: string }): Promise<void> {
    await this.#collection.updateOne({ _id: id }, { $set: { status: "failed", error, updatedAt: this.clock.now() } });
  }
}

export class MongoUserStore implements UserStore {
  readonly #collection: Collection<Stored<Record<string, unknown>>>;

  constructor(db: Db) {
    this.#collection = db.collection("users");
  }

  async findById(id: string): Promise<UserRecord | null> {
    return strip<UserRecord>(await this.#collection.findOne({ _id: id }));
  }

  async create(user: UserRecord): Promise<void> {
    const { id, ...rest } = user;
    await this.#collection.replaceOne({ _id: id }, { _id: id, ...rest }, { upsert: true });
  }
}
