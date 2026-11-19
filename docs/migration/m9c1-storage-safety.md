# M9C1 — Persistent Storage Authorization and Cross-Process Writer Safety

Status: storage-safety contract only. This milestone does not migrate the ADAPT checkout, does not authorize that checkout, does not deploy a server, and does not implement Security S2B. It is not a launch decision.

Labels:

- **Implemented** — present in this branch and covered by tests on disposable roots.
- **Contract** — required of the future M9C2 migration command. M9C1 does not execute it against real data.
- **Unsupported** — a deployment that cannot meet the condition must stay on Legacy. Do not treat it as safe.
- **Decision needed** — ADAPT or IT must choose before M9C3.
- **Blocker** — operational launch must not pass this point until the condition is met.

M9C1 verdict is recorded in the milestone report, not in this file as a launch approval. M9C2 adds the persistent migration command, the persistent launcher, and the backup helper described here. Those commands are specified in `docs/migration/m9c2-deployment-plan.md`. They have not been run against the real ADAPT checkout.

## 1. Persistent-root authorization

`authorizeVersionedFixture` is unchanged. It authorizes one isolated temporary fixture and nothing else.

`authorizeVersionedPersistentRoot({ configPath })` is a separate capability. It reads one external JSON file and returns a frozen token. `createPrompterServer` accepts that token only as `persistentRoot`. The function re-reads the file before startup. A plain object, header, query parameter, or environment variable is not a token.

`node server.js` calls `createPrompterServer()` with no token. A committed `migration.json` on the checkout still refuses startup and does not listen.

Runtime authorization and migration authorization are different files and different purposes:

| Purpose | Constant | What it allows |
| --- | --- | --- |
| `adapt-persistent-runtime` | runtime | Open one already committed installation that matches the file |
| `adapt-persistent-migration` | migration | Claim exclusive ownership and recheck a Legacy source manifest. It does not stage or commit |

A runtime file cannot start a migration. A migration file cannot start the server. Supplying both a fixture token and a persistent token fails with `ambiguous-authorization`.

The checkout is never a writable versioned root. A config file stored inside the checkout is rejected. A config that names the checkout, a path inside it, or a path that contains it is rejected with `repository-root`. There is no `confirmCheckoutRoot` override.

## 2. External configuration

The file is operator-controlled and must not be committed. Required checks, enforced where the operating system provides them:

- Absolute path to a regular file.
- Not a symbolic link. Opened with `O_NOFOLLOW`.
- Owner uid equals the uid of the process that reads it. Platforms without `process.getuid` cannot make this check.
- Mode exactly `0600` or `0400`.
- Resolved path is outside the checkout.
- UTF-8 JSON, at most 1 MiB, no extra keys.

Runtime file, every key required:

```json
{
  "schema": 1,
  "purpose": "adapt-persistent-runtime",
  "root": "<canonical-storage-root>",
  "libraryDir": "<canonical-storage-root>/data/library",
  "scriptFile": "<canonical-storage-root>/script.txt",
  "previousFile": "<canonical-storage-root>/script.previous.txt",
  "journalDir": "<canonical-storage-root>/data/live-journal",
  "installation": {
    "schema": 2,
    "state": "committed",
    "migrationId": "<migration-id>",
    "productionId": "<live-production-id>",
    "versionId": "<live-version-id>",
    "contentHash": "<64-hex-sha256>"
  }
}
```

A schema 3 fresh installation uses `kind: "fresh"` and `installationId` instead of the schema 2 identity fields. The real ADAPT library is schema 2. Schema 3 is only for a fresh install.

`mirrorInstalled` and `liveInstalled` are operational flags. They are not part of the authorization identity, because they change after installation and after the first Set as Live.

The angle-bracket values above are placeholders. They are not approved paths, hostnames, or secrets. M9C2 must substitute the canonical paths ADAPT actually approves, and must keep that file outside git.

Every configured path is walked component by component. A symlink anywhere on the path is rejected. The lexical path must equal `realpath`, so a directory alias such as `/tmp` versus `/private/tmp` does not match unless the file names the already resolved path. The library, both script files, `script.previous.txt.meta.json`, and the journal directory must be the root or sit inside it. The journal directory may be absent; it is created only after the writer lock is held.

The marker on disk must be committed and must match the installation object: schema, state, and the schema 2 migration, production, version, and content hash, or the schema 3 installation id. Any other marker fails closed.

Migration file, every key required:

```json
{
  "schema": 1,
  "purpose": "adapt-persistent-migration",
  "root": "<canonical-storage-root>",
  "libraryDir": "<canonical-storage-root>/data/library",
  "scriptFile": "<canonical-storage-root>/script.txt",
  "previousFile": "<canonical-storage-root>/script.previous.txt",
  "journalDir": "<canonical-storage-root>/data/live-journal",
  "expectedLiveProductionId": "<legacy-live-production-id>",
  "sourceManifest": {
    "script.txt": "<64-hex-sha256>"
  }
}
```

`sourceManifest` maps relative paths to SHA-256 hex. Absolute paths and `..` are rejected. The manifest is hashed before the lock and again after the lock is held.

No authorization file for the real ADAPT root is created by this milestone.

## 3. Single-writer ownership

The in-process service queue still orders operations inside one process. It does not stop a second operating-system process. M9B showed a second process could listen on the same rehearsal root.

The cross-process lock is a kernel `flock` on one file:

`<canonical-library-directory>/.writer.lock`

The canonical library directory is `realpath` of `data/library`. A symlink alias of that directory resolves to the same file and gets `writer-locked`. A different spelling that resolves to the same directory shares the lock. The lock file itself must be a regular file. If it is a symlink, or if its inode changes between open and lock, the caller gets `unsafe-lock` and does not replace the file.

Implementation:

- One Perl helper per canonical library per process, started from a worker thread.
- `sysopen` with `O_RDWR | O_CREAT | O_NOFOLLOW` and mode `0600`.
- `flock` with `LOCK_EX | LOCK_NB`.
- The helper prints `READY` and then blocks on stdin.
- The parent holds a refcount. Nested startup, recovery, and save calls share that helper. They do not open a second flock in the same process.
- The helper is never told to unlink the lock file.
- A PID recorded in the file is never consulted, and a supposedly stale lock is never deleted.

The file stays empty. It is ownership state, not library content. Snapshots of migrated content ignore that one name. Releasing the lock does not delete it. Deleting it would let a second process lock a new inode while the owner still holds the old one.

Codes:

| Code | Meaning | HTTP |
| --- | --- | --- |
| `writer-locked` | Another process holds the flock | 503 |
| `writer-lock-lost` | This process's helper exited while the hold was still recorded | 503 |
| `lock-unsupported` | The filesystem refused the lock, or the helper did not become ready within 5 seconds | 503 |
| `unsafe-lock` | The lock path is missing, is a symlink, or escaped the library | — |

`writer-active` remains the same-process refusal and is unchanged.

## 4. Filesystem assumptions

**Supported for the lock implemented here:** one host, a local POSIX filesystem where `flock` on a regular file is exclusive across processes and is released when every file descriptor closes. This development host is macOS APFS. The child-process tests passed on that filesystem. A Linux host with local ext4 is the expected production shape only if IT confirms `flock` there before cutover.

**Unsupported:**

- NFS, SMB, or any share where `flock` is not coherent across hosts.
- Two hosts mounting the same library, even if each host's local `flock` succeeds.
- Windows. This implementation uses a POSIX Perl helper and `process.getuid`.
- A filesystem that returns `ENOTSUP` or `EOPNOTSUPP` for `flock`. The caller receives `lock-unsupported` and must not listen or write.
- A deployment that "recovers" by deleting `.writer.lock` or by trusting a PID.

If the chosen disk cannot provide this lock, M9C2 marks that configuration unsupported and stays on Legacy. That outcome is a BLOCK for versioned launch, not a weaker lock.

## 5. Failure and restart

| Event | Behavior |
| --- | --- |
| Second process, same canonical library | `writer-locked` before writable open and before `listen` |
| Unrelated library | Independent lock; both may run |
| Normal shutdown | Queue drains, then the last refcount closes the helper stdin, then the kernel releases `flock`. The empty file remains |
| Startup throws before `listen` | The same release runs after writers have stopped. The hold is not left behind |
| `close()` called twice | One shared shutdown promise |
| HTTP `close` while operations are queued | `service.close()` waits for the in-process queue, then the boot hold is released |
| WebSocket clients | Terminated before the HTTP server closes. Shutdown still reaches the lock release |
| Process killed (`SIGKILL`) | The helper's stdin closes, the helper exits, and the kernel releases `flock`. The empty lock file remains. A later process may acquire it. No PID heuristic runs |
| Helper dies while this process still believes it holds the lock | The next acquire in this process throws `writer-lock-lost` and drops the holder. The in-flight operation must not continue writing |

A restart reads the committed marker and journals before it listens again. A corrupt journal is still refused and left in place. The new lock does not catch that error and does not rebuild Live State.

## 6. Supervisor model

Run one process for one canonical library. The supervisor:

1. Starts only after the runtime authorization file exists with the ownership and mode in section 2.
2. Calls `authorizeVersionedPersistentRoot({ configPath })` in the server process.
3. Passes the returned token to `createPrompterServer({ persistentRoot, ... })`.
4. Restarts only after the previous process has exited, so the kernel has dropped the flock.
5. Treats `writer-locked` and `lock-unsupported` as a failed start, not as a reason to delete the lock file.

Do not point two supervisors at the same library. Do not wrap `node server.js` and expect it to discover the authorization file. The current `server.js` listener is still `0.0.0.0` and the `PORT` environment variable (default 3000). M9C1 does not change that bind and does not claim it is safe to expose.

## 7. Trusted migration command

M9C2 may add the production command. M9C1 only defines the ownership contract. The command must, in one process:

1. Read a migration-purpose file, not a runtime-purpose file.
2. Resolve the approved destination root and reject the checkout.
3. Confirm the original Legacy inventory, including `expectedLiveProductionId`.
4. Validate `sourceManifest` against the current bytes.
5. Call `beginPersistentMigration({ configPath })` and hold the returned `release` function.
6. If that call returns `writer-locked`, stop. A running server already owns the library. Do not stage.
7. Recheck the manifest under the lock. `beginPersistentMigration` does this before it returns.
8. Run prepare and verify in that same process while the hold is still active. A second process, or a second flock helper in this process, will not get the lock.
9. Stop at an explicit commit boundary. Prepare must not commit.
10. Commit the schema 2 marker only after verification. Preserve the recovery copy and the rollback plan outside the library.
11. Call `release()` on every exit, including failure.

The fixture CLI (`--dry-run`, `--prepare`, `--verify`, `--abort`, `--commit`) still accepts only a temporary root. Dry-run and verify do not take the lock. Prepare, abort, and commit do. A missing library directory, or a library path that is not a directory or a symlink to one, fails with `unsafe-lock` and does not write. A symlink library resolves to the canonical lock.

`beginPersistentMigration` does not stage, commit, or modify a marker. M9C1 does not run it against the real ADAPT tree.

Generated ids from the M9B rehearsal are not expected hashes for M9C. A later prepare assigns new ids.

## 8. Path containment

Writable versioned opens use `assessWritableRoot`:

- The checkout, any path inside it, and any path that contains it are `unsafe-root`.
- A path inside a root retained by an accepted persistent token is `persistent`.
- A path inside the OS temporary directory, other than the temporary directory itself, is `fixture`.
- Everything else is `unsafe-root`.

Retention lasts from authorization acceptance until the shutdown promise finishes. Direct factories (version store, install, recovery, live operations, production management, assets, migration prepare/commit/abort) take the same library flock when they are allowed to write. They do not accept a header or a role as permission.

Read-only version-store opens are unchanged. A read-only open cannot save.

## 9. Startup and shutdown order

For an authorized persistent root, the server process does this in order:

1. Re-read the authorization file and match the committed marker.
2. Retain that one root.
3. Acquire the library flock.
4. Create the journal directory if it is missing.
5. Open the coordinated library service, which takes another refcount on the same flock.
6. Recover journals and, when required, install Live State. Those writes happen only while the flock is held.
7. Build the HTTP and WebSocket handlers.
8. Return the server. `listen` happens after this return. A second process that lost the lock never reaches `listen`.

On failure before the return, the process releases the service refcount if the service opened, then the boot refcount, then the retained root. It does not listen.

On `close()`:

1. Terminate WebSocket clients.
2. Close the WebSocket server, then the HTTP server.
3. Drain the in-process operation queue.
4. Drop the service refcount, then the boot refcount.
5. Drop the retained root.

The HTTP `close` event uses the same shutdown promise, so a second writer cannot start on the strength of the socket closing while the queue is still draining.

Legacy startup, with no `migration.json`, does not acquire this lock and does not create `.writer.lock`.

## 10. Security limitations before S2B

These operations are still unauthenticated, with or without `PROMPTER_STAFF_TOKEN`:

- `POST /script`
- Restore Previous through `POST /script` (`X-Restore-Previous: 1`)
- WebSocket `navigate`
- WebSocket `goto`
- WebSocket `reloadScript`

The staff token still protects the library routes that already required it. It does not close the list above. A public Audience page that shares this WebSocket can move the cue. M9C1 adds no staff check and no new public route.

**Blocker.** Do not enable public HTTP or WebSocket access before a tested network boundary makes those operations unreachable from untrusted clients, or before Security S2B. An HTTP proxy that blocks `POST` and leaves the WebSocket open is not that boundary. M9A section H is still the interim requirement. No firewall, VPN, or gateway was tested here.

This document is not production launch readiness.

## 11. Prerequisites still requiring ADAPT IT

M9C2 and M9C3 still need decisions that this repository cannot invent:

- The host and the local disk that will hold the canonical root.
- Confirmation that the disk's `flock` matches section 4.
- One supervisor for that one process, and the account that will own the authorization file.
- The approved canonical paths, written only into the uncommitted authorization file.
- A tested private-network or gateway control for every HTTP and WebSocket entry, including cue commands.
- A production backup that is not the M9B rehearsal copy, plus a named rollback approver and a maintenance window.
- The GO / NO-GO checklist from M9A.

No hostname, credential, operator name, or approved path is assigned here.

## 12. Risks

- The lock is per host. Two machines that both mount the library are unsupported even if each believes it holds `flock`.
- An operator who deletes `.writer.lock` while a server is running creates a second inode. The old process keeps the old lock. The new process can lock the new file. Do not delete the file.
- Dry-run and verify do not take the lock. They must not be treated as writers. Prepare, abort, and commit do take it.
- `lock-unsupported` after 5 seconds can also mean the helper failed to start. The process must stop rather than write.
- The empty `.writer.lock` file appears under `data/library` after the first writer opens it. It is not a marker and not Live State. Content comparisons must not treat it as a migrated script or asset.
- Authorization proves which root a trusted operator configured. It does not authenticate HTTP clients.

## 13. M9C2 integration checklist

- [ ] Choose a host and a local filesystem that implements the `flock` semantics in section 4. Record the result. If it does not, stop and stay on Legacy.
- [ ] Place the runtime authorization file outside the checkout, mode `0600` or `0400`, owned by the server account.
- [ ] Bind it to the committed schema 2 installation identity after migration, not to `mirrorInstalled` or `liveInstalled`.
- [ ] Start the server only through `authorizeVersionedPersistentRoot`. Do not rely on `node server.js` to find the file.
- [ ] Confirm a second process against that root exits `writer-locked` and does not listen.
- [ ] Confirm shutdown lets a later process acquire the same root, and that killing the process releases the flock without deleting the file.
- [ ] Run the migration command in section 7 in the same process as `beginPersistentMigration`, and confirm it refuses to start while the server holds the lock.
- [ ] Keep the production backup and rollback copy outside the library. Do not reuse M9B version or asset ids as expected hashes.
- [ ] Keep the listener unreachable from untrusted networks until the section 10 tests pass.
- [ ] Do not add Security S2B on this branch.
