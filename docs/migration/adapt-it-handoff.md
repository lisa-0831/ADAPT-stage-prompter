# ADAPT IT Handoff — Versioned Stage Prompter

Status: planning handoff for M9C3A. No host has been chosen, no production server has been deployed, and the ADAPT checkout has not been migrated. The current GO/NO-GO result is **NO-GO**. See `docs/migration/m9c3-go-no-go.md`.

This note is for the people who will provision the machine. It does not assign a hostname, a path, a credential, or an approver.

## 1. What the application is

Stage Prompter shows one live script to three kinds of screens:

- Controller, used by staff to move the cue and manage the library
- Actor, which can browse locally and then return to the live cue
- Audience, which follows the live cue

The screens stay together through one Node.js process. That process serves the web pages over HTTP and pushes cue changes over a WebSocket on the same port. The script, the library, and the stage images are files on disk. They are not stored in the browser.

The repository ships a Versioned Library under `data/library/productions/`, with WELCOME as the production. `npm install` and `npm start` are the normal installation. The first start copies that seed outside the checkout and serves it on `127.0.0.1`. It does not run Legacy migration. `npm run setup` remains an optional tool for a different Legacy library. This first-time install is not a production cutover, and it does not approve a public address. The production gate below stays **NO-GO**. Security choices and their effect on Controller, Actor, and Audience are in [security-ux-decisions.md](security-ux-decisions.md).

## 2. Why this cannot be a static site

GitHub Pages, or any host that only publishes HTML and images, cannot run this application.

The server has to:

- Keep one shared cue in memory and send it to every connected screen
- Accept a WebSocket connection and forward `Upgrade` traffic
- Write a new live script, a library version, or an image when staff publish or save
- Recover those writes after a crash by reading journals on disk
- Refuse a second process that tries to write the same library

A static host can show a snapshot of a page. It cannot keep the cue, the library, or the lock. The installed entry point is `npm start` (`scripts/start-installed.js`). It listens on `127.0.0.1` and reads the runtime authorization file created on first start. `scripts/start-persistent.js` remains the command that can point at an authorization file on a host ADAPT IT chooses later. `npm run start:legacy` (`node server.js`) is the old checkout server. It can listen on every interface, and it will not open a committed versioned library.

## 3. What development has already built

These pieces are in the branch `feat/versioned-script-library`. They were tested on disposable directories and on this development Mac. They were not run against a production host.

| Piece | Command or module | What it does |
| --- | --- | --- |
| Fixture migration | `scripts/migrate-library.js` | Temporary-directory rehearsal only |
| Persistent migration | `scripts/migrate-persistent.js` | Authorized prepare and commit for one root outside the checkout |
| Persistent server | `scripts/start-persistent.js` | Starts one versioned server from a runtime authorization file |
| Backup | `scripts/backup-storage.js` | Stopped-writer copy, hash check, and restore into an empty directory |
| Writer lock | `server/storage-writer-lock.js` | One exclusive `flock` per library, released when the process dies |
| Authorization | `server/persistent-authorization.js` | Separate files for migration and for runtime |

The rehearsal in `docs/migration/m9b-rehearsal.md` migrated a copy. It is not a production backup and its generated version ids must not be reused.

Security S2B is not in this branch. It is a later, separate pull request. See section 12.

## 4. What IT has to provide

Every row is still open. Details are in sections 5 through 10.

- One host with a local disk, not a shared network filesystem
- A supported operating system, with Node.js and Perl installed
- One process supervisor for one server process
- A persistent directory for scripts, the library, images, and journals
- A directory outside git for the two authorization files
- A backup directory that is not the storage directory
- HTTPS termination that forwards WebSocket upgrades, if browsers will use HTTPS
- A private network or a login gateway in front of every HTTP and WebSocket connection
- Logs for the Node process
- Named owners for the host, the backup, the cutover, the rollback, and acceptance

No provider is selected here. A platform that offers only ephemeral disk, more than one instance, or no WebSocket upgrade is incompatible with this design.

## 5. Hosting requirements

`package.json` does not declare an `engines` range. The regression suites were run with Node.js **v24.18.0**. That is the tested runtime. A different Node.js version is **pending validation** until the same `node --test` and `npm run test:browser` suites pass on it. Do not assume an older long-term release is compatible without that run.

Perl must be on `PATH`. The lock helper runs `perl -e` and uses POSIX `flock` with `LOCK_EX | LOCK_NB`. A host without Perl, or a filesystem that returns “operation not supported” for `flock`, cannot run the versioned server. The process fails closed. It does not fall back to an unlocked writer.

| Requirement | Needed state | Validation |
| --- | --- | --- |
| Operating system | A POSIX host whose local disk implements `flock` | Pending. macOS APFS passed in development. Linux is not automatically approved |
| Node.js | v24.18.0 until another version is tested | Tested only on the development machine |
| Perl | Available as `perl` for the lock helper | Tested on the development machine |
| Filesystem | One local disk. Not NFS, SMB, or a disk mounted by two hosts | Pending on the production host |
| Processes | Exactly one server process for that library | Pending. The supervisor has not been chosen |
| Startup | `scripts/start-persistent.js --config <runtime-file>` | Implemented. Not deployed |
| Shutdown | Stop that process and wait until it exits before starting another | Implemented in the server. Not exercised by a production supervisor |
| Disk | Durable directory for the current scripts and images, plus version history | Current shared images are about 9 MB. Versioned copies add production-owned duplicates. Final size is pending the production backup |
| Permissions | The server account owns the storage root and the authorization files. Authorization files are mode `0600` or `0400` | Pending |
| Authorization file | Outside the git checkout | Design is done. The real file has not been created |
| HTTPS | Terminate in front of Node and forward `Upgrade` and `Connection` | Pending |
| WebSocket | Same port as HTTP | Implemented in the application. Gateway forwarding is pending |
| Logs | stdout and stderr of the one Node process | Pending where they are stored |
| Backups | A separate directory, kept by a named owner | Pending |

Windows, NFS, SMB, and two hosts sharing one library are unsupported. A serverless or container platform that replaces the disk on every deploy is unsupported unless the storage root is a separate durable volume that survives the deploy. That arrangement is still pending a host test.

## 6. Storage layout

These names are illustrations. They are not approved paths.

| Role | Illustration | Survives restart, code update, deploy rollback, and host reboot |
| --- | --- | --- |
| Application checkout | `<application-checkout>` | The git checkout can be replaced. It is not the library |
| Persistent storage | `<persistent-storage-root>` | Yes. This is the library |
| Runtime and migration files | `<config-directory>` | Yes. They must not be inside the checkout |
| Backups | `<backup-directory>` | Yes. Not inside the storage root |
| Logs | `<log-directory>` | Logs may rotate. The cutover record should be copied somewhere durable |

`<persistent-storage-root>` holds `script.txt`, `script.previous.txt`, `script.previous.txt.meta.json`, `data/library`, `images`, and `data/live-journal`. A git clone already contains the Versioned productions under `data/library/productions/`, plus `images/`. It does not contain the machine-local marker, Live State, authorization files, or backups. `npm start` copies the seed into this root. That install is not the later production cutover.

The runtime authorization file names that one root and one committed installation. For the ADAPT migration the marker is schema 2. The file must match `migrationId`, `productionId`, `versionId`, and `contentHash` from `data/library/migration.json`. `mirrorInstalled` and `liveInstalled` change during operation and are not part of the match. If they differ, the server refuses to listen.

Do not commit either authorization file. Do not commit `PROMPTER_STAFF_TOKEN`.

The empty file `data/library/.writer.lock` appears the first time a process takes the lock. Leave it in place. Deleting it while a server is running lets a second process lock a new file.

## 7. Two different locks on access

These are not substitutes for each other.

**Staff token.** `PROMPTER_STAFF_TOKEN` is one shared passphrase. The browser sends it as `X-Staff-Token` on library routes. If the variable is empty, those library routes are open to anyone who can reach the port. The token does not apply to `POST /script`, Restore Previous, or the WebSocket commands that move the cue.

**Network or gateway.** Until Security S2B, every HTTP request and every WebSocket connection must be reachable only from approved devices. That means a private show network with no route from guests, a VPN, or a gateway that requires a login before the connection is allowed. A reverse proxy that exists, but does not enforce that rule, is not protection.

CORS, an unlisted URL, and `?role=audience` do not authenticate anyone. `role` only changes which controls the page draws.

## 8. HTTP and WebSocket matrix

“Application authentication” is the check inside this Node process today. “Interim boundary” is what has to be true before launch, because the application check is missing or incomplete.

| Operation | Request or message | Application authentication | Interim boundary |
| --- | --- | --- | --- |
| Open the page | `GET /` | None | Approved devices only |
| Read the live script | `GET /script` | None | Approved devices only |
| Read the previous live script | `GET /script/previous` | None | Approved devices only |
| Publish or replace the live script | `POST /script` | None | Must be unreachable from unapproved devices |
| Restore Previous Live | `POST /script` with header `X-Restore-Previous: 1` | None | Must be unreachable from unapproved devices |
| Connect | WebSocket upgrade on the same port | None | Must be unreachable from unapproved devices |
| Move the cue | WebSocket `navigate` | None | Same connection as the upgrade. Filtering HTTP POST does not stop this |
| Jump to a line | WebSocket `goto` | None | Same |
| Reload the live script from disk | WebSocket `reloadScript` | None | Same |
| Server pushes the show | WebSocket `script` and `state` | Sent by the server after connect | Only approved devices may connect |
| Shared stage images | `GET /images/...` | None | Approved devices only |
| Page assets | `GET /public/...`, `GET /fonts/...` | None | Approved devices only |
| Live production image | `GET /api/live/assets/:productionId/:assetId` | None. Bytes are served only for the live show | Approved devices only |
| Ask whether a staff token is configured | `GET /api/library/access` | None. Returns whether a token is set, not the token | Approved devices only |
| List, read, create, rename the library | `GET` and `POST /api/library`, `GET` and `PUT /api/library/:id` | `X-Staff-Token` when the token is set. Open when it is unset | Approved devices, and the token must be set |
| Set as Live | `POST /api/library/:id/live` | Staff token, same rule | Approved devices, token set |
| Upload, list, delete library images | `/api/library/:id/assets` | Staff token, same rule | Approved devices, token set |
| Preview a library image | `GET /api/library/:id/assets/:assetId` | Staff token, same rule | Approved devices, token set |
| List and read version history | `GET /api/library/:id/versions` and `.../versions/:versionId` | Staff token, same rule | Approved devices, token set |
| Restore a historical version as a new saved head | `POST /api/library/:id/versions/:versionId/restore` | Staff token, same rule | Approved devices, token set |

A public Audience page that uses this WebSocket also accepts `navigate`, `goto`, and `reloadScript` from any client that can open the socket. That shape is blocked until Security S2B, or until a gateway has been shown to drop those messages while still delivering `script` and `state`. No such gateway is specified or tested.

## 9. Network tests to run later

Run these on the real host, from the real networks, after IT has built the boundary. Use approved clients. Do not scan ADAPT networks from this milestone. Every row is **NOT RUN**.

1. An approved device loads the page.
2. An approved Controller publishes and moves the cue.
3. An approved Audience device receives the script and the cue.
4. An unapproved device cannot open the Node port directly.
5. An unapproved device cannot `POST /script`.
6. An unapproved device cannot send Restore Previous (`POST /script` and `X-Restore-Previous: 1`).
7. An unapproved device cannot complete the WebSocket upgrade.
8. The Node listen port cannot be reached by going around the gateway.
9. HTTPS, if used, and the WebSocket upgrade both succeed through the gateway from an approved device.
10. After the Node process restarts, rows 4 through 8 still fail for an unapproved device.

A pass on a developer laptop does not count.

## 10. Filesystem test to run on the chosen host

The development Mac, on APFS, passed child-process lock tests. That does not validate Linux or any other disk.

On the chosen host, with a disposable directory on the production filesystem, show:

- The first process holds `flock` on `data/library/.writer.lock`
- A second operating-system process is refused with `writer-locked` and does not listen
- Killing the owner releases the lock and leaves the lock file in place
- A new process can acquire it
- A symlink to the library does not create a second writer
- Files are still there after a host reboot
- The directory is not wiped by an application redeploy

Until that run exists, the filesystem gate is **NOT RUN**. NFS, SMB, and multi-host mounts are unsupported even if a local test passes.

## 11. Backup gate before any real migration

The M9B rehearsal copy is not this backup. Do not create the production backup in M9C3A.

Before the later cutover, the operator will:

1. Stop every process that can write the Legacy files, including `node server.js`.
2. Confirm no server is still writing.
3. Record SHA-256 hashes of the live script, the previous script and its metadata, the library index, each library script, and the shared images.
4. Run `node scripts/backup-storage.js create --source <persistent-storage-root> --dest <empty-backup-directory>`.
5. Run `node scripts/backup-storage.js verify --dest <empty-backup-directory>`.
6. Run `node scripts/backup-storage.js restore --dest <empty-backup-directory> --restore-to <empty-restore-directory>`.
7. Compare the restored files with the source hashes.
8. Record who owns the backup and how long it is kept.
9. Record where the restore test lives.
10. Get the maintenance window approved.

`create` takes the writer lock. It fails if a server is still running. It refuses the git checkout and it refuses a destination inside the source.

## 12. How the later cutover commands work

There is no command that prepares, commits, and starts the server in one step. Ordinary startup does not migrate.

Inspect first. These commands still take the writer lock. `preflight` does not stage or commit. The first lock can create an empty `.writer.lock`. Do not point them at the real root until the backup gate has passed.

```text
node scripts/migrate-persistent.js preflight --config <migration-authorization>
```

The migration file is purpose `adapt-persistent-migration`. It names one root, the library, the script paths, the journal path, the expected live production, and a source hash manifest. Live is chosen by matching `script.txt` bytes to a saved script. The old library `liveId` is not the live show. For the current ADAPT library the byte match is WELCOME. Test stays a separate production. The stored `liveId` may say Test. That drift is expected and must not be “corrected” by hand.

Writes:

```text
node scripts/migrate-persistent.js prepare --config <migration-authorization>
```

`prepare` stages the versioned tree and prints `planHash`. It does not write `migration.json`. Read the hash, both production ids, and the live production id before anyone continues.

```text
node scripts/migrate-persistent.js commit --config <migration-authorization> --plan <plan-hash-from-prepare>
```

`commit` writes the marker only when `--plan` is that exact hash. There is no `--yes`. A wrong hash does not commit. A running server returns `writer-locked`.

```text
node scripts/migrate-persistent.js abort --config <migration-authorization>
```

`abort` deletes an uncommitted attempt. It refuses to remove a committed marker.

After commit, write a second file, purpose `adapt-persistent-runtime`, with the marker’s `migrationId`, `productionId`, `versionId`, and `contentHash`. Then:

```text
node scripts/start-persistent.js --config <runtime-authorization> --port <port> --bind <address>
```

The default bind is `127.0.0.1`. `0.0.0.0` is rejected. Loopback does not serve phones and laptops on the show network. A specific private address is allowed only after the network tests in section 9 pass. The first successful start installs Live State. `previousActivation` stays null. A restart reads that Live State. It does not migrate again.

A migration file cannot start the server. A runtime file cannot run `prepare` or `commit`.

The step order, the GO checks, and the rollback limits are in `docs/migration/m9c3-cutover-runbook.md`.

## 13. Who decides what

| Decision | State |
| --- | --- |
| Hosting platform and host owner | Awaiting ADAPT/IT |
| Operating system | Awaiting ADAPT/IT |
| Persistent filesystem type | Awaiting ADAPT/IT |
| Application process owner | Awaiting ADAPT/IT |
| Reverse proxy or gateway owner | Awaiting ADAPT/IT |
| Network access policy owner | Awaiting ADAPT/IT |
| Backup owner and retention | Awaiting ADAPT/IT |
| Technical cutover operator | Awaiting ADAPT/IT |
| Rollback approver | Awaiting ADAPT/IT |
| Maintenance window | Awaiting ADAPT/IT |
| ADAPT operational acceptance owner | Awaiting ADAPT/IT |

Nothing in this table is proposed under a person’s name. Filling a name in without ADAPT is not allowed.

## 14. Security S2B stays separate

The order is:

1. Finish the operational cutover and acceptance in a later milestone, M9C3B.
2. Keep a stable Versioned Library release.
3. Merge the Versioned Script Library pull request when it is approved.
4. Branch `feat/security-s2b` from that stable default branch.
5. Open a separate pull request for staff authentication that covers the routes in section 8 which are open today.
6. Review the changed Controller workflow with ADAPT before that pull request is treated as ready.

Until that later work is implemented and tested, the gateway or private network in section 7 stays mandatory. Launching a public Audience URL on the current WebSocket is a NO-GO.

## 15. What this milestone did not do

No real migration. No production authorization file. No copy of ADAPT data to a host. No deployed server. No opened port. No network probe. No commit is requested by this document.
