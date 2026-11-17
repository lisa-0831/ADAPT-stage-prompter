# M9C2 — Deployment and Cutover Preparation

Status: tooling and operational contract. This milestone does not migrate the ADAPT checkout, does not authorize that checkout, does not deploy a server, and does not implement Security S2B. It is not a launch decision.

Labels:

- **Implemented** — present in this branch and covered by tests on disposable roots.
- **Tested locally** — observed on this development host (macOS, APFS). Not a production-host result.
- **Needs production-host test** — required on the host ADAPT actually chooses before M9C3 can pass.
- **Decision needed** — ADAPT or IT must choose. This document does not invent the answer.
- **Blocks M9C3** — operational launch must not pass this point until the condition is met.

The cutover steps are in `docs/migration/m9c3-cutover-runbook.md`.

## 1. Locations that must stay separate

`git clone` does not contain the ADAPT library. `data/` is gitignored. The checkout is not an authorized writable root.

| Role | What it holds | Where it must live |
| --- | --- | --- |
| Application checkout | This repository's code | A directory that is not the storage root |
| Persistent storage root | Live script, previous script, library, images, journals, marker | One canonical directory outside the checkout |
| Legacy source snapshot | The stopped-writer copy that migration reads | The persistent root, after a verified copy is placed there |
| Migration authorization | `adapt-persistent-migration` JSON | Outside the checkout and outside git |
| Runtime authorization | `adapt-persistent-runtime` JSON | Outside the checkout and outside git |
| Backup | SHA-256 manifest and file copy | A directory that is neither the checkout nor the storage root |
| Restore test | A second copy used only to prove the backup | A third empty directory |

M9C2 does not copy the real ADAPT files to a host. M9C3 places one verified Legacy snapshot into the approved persistent root. The migration command reads that root from the authorization file. It has no `--root` flag and no `--yes` flag.

## 2. Trusted migration command

Implemented. The fixture CLI is unchanged and still accepts only a temporary root.

```text
node scripts/migrate-persistent.js preflight --config <authorization-file>
node scripts/migrate-persistent.js prepare --config <authorization-file>
node scripts/migrate-persistent.js commit --config <authorization-file> --plan <64-hex-plan-hash>
node scripts/migrate-persistent.js abort --config <authorization-file>
```

The file purpose must be `adapt-persistent-migration`. A runtime authorization cannot run these commands. The root, library, scripts, journal, expected live production, and source manifest come only from that file. The checkout, a path inside it, and a path that contains it are rejected.

`preflight` acquires the writer lock, checks the manifest and the byte-matched live production, and releases the lock. It does not stage. The stored library `liveId` is not the live production. A mismatch is reported as `live-id-drift` and ignored. If the bytes do not match `expectedLiveProductionId`, the command returns `live-mismatch`.

`prepare` holds the same lock while it revalidates the manifest, prepares with the existing planner and staging code, and verifies READY. It prints `planHash`. It does not write `migration.json`.

`commit` holds the lock from the manifest check through the marker verification. It commits only when `--plan` is the hash printed by that prepare. A different hash returns `plan-mismatch` and does not write the marker. There is no confirmation flag that can skip the hash.

`abort` removes an uncommitted attempt. It refuses a committed marker.

A committed marker returns `already-committed`. The command does not rewrite it. An unexpected file, a changed hash, a symlink lock, a missing authorization, and a second writer all fail closed.

The plan hash is the commit authorization. The operator compares it with the preflight record before typing it into `commit`. A later prepare allocates new ids, so an old hash must not be reused.

## 3. Writer ownership during migration

**Tested locally.** `beginPersistentMigration` takes an exclusive flock on `data/library/.writer.lock` for the whole command. The lock is not released between revalidation, prepare, verify, and, on `commit`, the marker write. It is released in a `finally` path after those writes finish, including when the command fails.

Prepare and commit are two process invocations. The lock is not held while a person reads the plan. Commit acquires it again and repeats the manifest check, the READY check, and the plan-hash check before it writes. A change in that gap fails the commit. A running server keeps the flock, so the migration command returns `writer-locked` and does not stage.

The server and the migration command both use exclusive ownership. A nested claim in the same process is also `writer-locked`. The in-process operation queue remains for requests inside the running server. Staging writes under `migration-work` use a separate lock file and only while the persistent root is retained for that command.

An empty `.writer.lock` remains after release. Do not delete it.

## 4. Persistent runtime launcher

Implemented. `node server.js` is unchanged. It still binds `0.0.0.0` and it still refuses a committed marker when no trusted token is passed.

```text
node scripts/start-persistent.js --config <runtime-authorization> [--port <0-65535>] [--bind <address>]
```

The file purpose must be `adapt-persistent-runtime`. A migration authorization cannot start this process. The launcher calls `authorizeVersionedPersistentRoot` and then `createPrompterServer({ persistentRoot })`. No environment variable selects the storage root.

The default bind address is `127.0.0.1`. `0.0.0.0`, `::`, and `*` are rejected with `public-bind` before listen. A specific private address can be passed with `--bind` when the host firewall is already proven to block that port from untrusted clients. Loopback alone does not serve Actor and Audience devices on other machines.

The first start of a committed schema 2 marker installs Live State while the flock is held. `previousActivation` stays null. A second start reads that Live State. A wrong migration id, production id, version id, or content hash fails before listen.

## 5. Operating system and filesystem

**Tested locally:** this development host, macOS, APFS, Perl `flock` (`LOCK_EX | LOCK_NB`), and the Node.js that runs `node --test`. Perl must be on `PATH`. The lock file is mode `0600`. The authorization file must be mode `0600` or `0400`, owned by the process uid, and not a symlink.

**Needs production-host test:** the same `flock` behavior on the chosen Linux host and its local disk. Do not treat that host as supported until the child-process lock tests have passed there.

**Unsupported:** NFS, SMB, two hosts mounting one library, Windows, and any filesystem that returns `lock-unsupported`. Those deployments stay on Legacy.

A supervisor restarts the process only after the previous process has exited, so the kernel has dropped the flock. `SIGKILL` releases the flock and leaves the empty lock file. Deleting that file while a process is running is unsafe. An application upgrade replaces the checkout, not the storage root. The storage root stays outside the checkout so a code update does not replace scripts, images, or the marker.

## 6. Hosting contract

Provider-neutral. No account is selected and nothing is deployed.

One Node.js process serves HTTP and WebSocket on the same port. The disk is local to that host. The supervisor passes `--config` to `scripts/start-persistent.js`. Logs are the process stdout and stderr. A health check can request `GET /script` only from inside the approved network. HTTPS termination, if used, is in front of this process and must forward `Upgrade` and `Connection` for WebSocket.

Incompatible with this design:

- A platform whose filesystem is not a local POSIX disk
- More than one application instance on the same library
- A serverless or ephemeral disk that does not keep the storage root across restarts
- A deploy that binds the persistent runtime to every interface and publishes that port

`node server.js` remains the Legacy and development entry point. It is not the persistent production entry point.

## 7. Network boundary before S2B

**Blocks M9C3.** This section has not been tested on a hosting network. M9C2 does not claim that it passed.

These operations are still unauthenticated, with or without `PROMPTER_STAFF_TOKEN`:

- `POST /script`
- Restore Previous through `POST /script`
- WebSocket `navigate`
- WebSocket `goto`
- WebSocket `reloadScript`
- Opening the WebSocket

The staff token still applies to the library mutation routes that already require it. Public `GET /script` and live image reads are part of the show. CORS, a hidden path, and `?role=` are not authorization.

An HTTP filter that blocks `POST` and leaves the WebSocket open does not meet this boundary. The whole process must sit on a private network or behind a gateway that requires a login before any HTTP or WebSocket connection. The backend port must not be reachable around that gateway. A public Audience page that shares this WebSocket remains blocked until Security S2B, or until a gateway proves it can drop the state-changing messages while still delivering the show. No such gateway is specified here.

M9C3 must repeat the reachability checks from the untrusted side of the real network. Those checks are not done in M9C2.

## 8. Backup and restore

Implemented and tested on disposable roots. This is not a production backup, and the M9B rehearsal copy is not one either.

```text
node scripts/backup-storage.js create --source <storage-root> --dest <empty-directory>
node scripts/backup-storage.js verify --dest <backup-directory>
node scripts/backup-storage.js restore --dest <backup-directory> --restore-to <empty-directory>
```

`create` takes the exclusive writer lock, so the server must already be stopped. It copies `script.txt`, the previous script and metadata when present, `data/library` except `.writer.lock`, `images`, and `data/live-journal` when present. It refuses symlinks, the checkout, and a destination inside the source. It writes `backup-manifest.json` with a SHA-256 for each copied file, mode `0600`.

`verify` rehashes every file and rejects extras. `restore` copies into an empty directory that is not the backup and not the checkout. It does not delete the source and it does not delete a marker to recreate Legacy mode.

The backup operator is responsible for where that directory lives and how long it is kept. Those choices are **Decision needed**.

## 9. Rollback and data loss

There is no reverse migration. Deleting `migration.json` does not return a tree to Legacy.

| Phase | Recovery |
| --- | --- |
| Before prepare | Keep using the Legacy snapshot. No marker exists. |
| During staging, before commit | `abort` removes the uncommitted attempt. The marker is absent. |
| After commit, before Live installation | Restore the verified backup into a replacement root, or restore it over the storage root only after the server is stopped. The marker is not deleted in place as a shortcut. |
| After Live installation, before audiences use it | The same restore. Installation has written Live State and the compatibility mirror. |
| After Controller, Actor, or Audience use | A Legacy restore discards saves, publishes, and activations made after the backup. A named rollback approver must accept that loss in writing before the restore. |

The approver's name is **Decision needed**. This document does not invent one.

## 10. What is still unknown

| Fact | State |
| --- | --- |
| Host, OS, and local disk | **Decision needed**. **Blocks M9C3** until `flock` is tested there |
| Process supervisor | **Decision needed** |
| HTTPS termination and WebSocket upgrade | **Decision needed**. **Needs production-host test** |
| Private network or gateway | **Decision needed**. **Blocks M9C3** |
| Actor and Audience connectivity | **Decision needed**. Public access before S2B **Blocks M9C3** |
| Staff token value | **Decision needed**. Keep it out of git. It does not close cue commands |
| Technical operator and rollback approver | **Decision needed**. **Blocks M9C3** |
| Backup location and retention | **Decision needed** |
| Maintenance window and acceptance owner | **Decision needed**. **Blocks M9C3** |

M9C3 is not ready while any **Blocks M9C3** row is open.
