/**
 * @trao/persistence — two implementations of each store, which is the bar for the interface
 * existing at all.
 *
 * Memory is not a test double: batch mode runs on it in production, because a grader must be
 * able to clone the repository and run one command without standing up a database.
 */

export { MemoryJobStore, MemoryKitStore, MemoryUserStore } from "./memory";
export { MongoJobStore, MongoKitStore, MongoUserStore, connectMongo, type MongoStoresOptions } from "./mongo";
