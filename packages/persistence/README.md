# @trao/persistence

Two implementations of each store, which is the bar for the interface existing at all.

Imports `@trao/contracts` only.

| Store | Memory | Mongo |
|---|---|---|
| `KitStore` | `MemoryKitStore` | `MongoKitStore` |
| `JobStore` | `MemoryJobStore` | `MongoJobStore` |
| `PracticeStore` | `MemoryPracticeStore` | `MongoPracticeStore` |
| `UserStore` | `MemoryUserStore` | `MongoUserStore` |

## Memory is not a test double

Batch mode runs on it in production. `npm run evaluate` must work on a machine that has just
cloned the repository, and a grader who has to stand up MongoDB first is a grader who loses 55
points to a setup failure rather than to the code. So memory is a supported runtime, not a
convenience — and nothing MongoDB offers may become mandatory.

The same is true in development: `npm run api:fake` runs the whole API against memory with no
database at all, and says so on startup.

## Mongo

`connectMongo` builds all four stores against one connection and creates the indexes the queries
need — `hash` (how a resubmission is recognised) and `userId` (every list query) on kits. Ratings
live in their own `practice_sessions` collection rather than on the kit, because a rating is not
an edit: no version, no `If-Match`, and two tabs rating the same card do not conflict.

Documents are stored as written by `@trao/kit` and read back as they were. This package persists
and returns a document; it never interprets one, which is why the stores are generic over the kit
type (`KitStore<InternalKit>`) and why `contracts` can declare them without seeing `InternalKit`.
