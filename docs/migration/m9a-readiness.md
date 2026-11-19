# M9A — Real ADAPT Migration Readiness

Status: audit and plan only. This document does not migrate the repository, enable production-root versioned startup, or change ADAPT storage.

Labels used below:

- **Verified** — checked against this working tree during M9A.
- **Proposal** — a design for a later milestone. It is not implemented.
- **Decision needed** — ADAPT or IT must choose before M9C.
- **Not tested** — no rehearsal or deployment has exercised this step.
- **Blocker** — M9C must not pass this point until the condition is met.

Audit commit: `3428f22` on `feat/versioned-script-library` (`feat: support first-install versioned waiting state`). The repository had no `docs/` tree before this file. Operator documentation today is `README.md`.

## A. Executive readiness summary

**Verified.** The checkout still starts as Legacy. `detectStorageMode` on `data/library` returns `mode: "legacy"`. There is no `migration.json`, `live-state.json`, `productions/` tree, or `data/live-journal/`. `node scripts/migrate-library.js --dry-run --root <this repository>` returns `unsafe-root` and does not inspect or write. Versioned startup still requires `authorizeVersionedFixture`, which accepts only one real directory under the OS temp directory and outside this repository.

**Verified.** The live script bytes match one saved production, WELCOME (`2d0f0937-fc36-4d27-a31e-d047c2fd5623`). The legacy library `liveId` points at Test (`ee04e849-90d4-4eeb-b2a6-562b06067a32`). The planner treats that as `live-id-drift` and selects WELCOME. The match is unique, so live identity is not ambiguous.

**Verified.** Both saved scripts use shared `images/` files. An in-memory planner run rewrites those five image lines in each script and leaves every other line unchanged. The migrated library must use schema 2, with `previousActivation: null` and `mirrorInstalled: false` until the existing installer runs. Schema 3 is the empty fresh-install contract from M8 and must not be written over this library.

**Blocker for M9C, not for this audit.** The current server refuses to listen when a committed marker is present unless the caller holds a fixture token. Committing a marker on the real root with today's binary takes the show offline. M9C needs a separate persistent-root authorization, a tested network boundary around unauthenticated writes, a confirmed host with a durable disk, and a verified backup. A public Audience URL while `POST /script` and cue WebSocket commands stay open is **Blocker**: that launch waits for Security S2B or an equivalent tested message filter. A restricted-network launch can be designed now and remains **Not tested**.

M9A verdict: **PASS WITH LIMITATIONS**. See section P.

## B. Verified real ADAPT inventory

Read on 16 November 2026 from this working tree. No migration command ran in write mode. The in-memory planner returned a plan and wrote nothing.

| Item | Verified value |
| --- | --- |
| Library index | `data/library/index.json`, schema `version: 1`, SHA-256 `ee9d8f81ff66b174d6806bc5a43250449aae8dc21b6799e0d9d95dcf633762f7` |
| Index keys | `version`, `liveId`, `scripts` |
| Legacy `liveId` | `ee04e849-90d4-4eeb-b2a6-562b06067a32` |
| `script.txt` | 23,299 bytes, 840 lines, SHA-256 `ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0` |
| `script.previous.txt` | Same length and the same SHA-256 as `script.txt` |
| `script.previous.txt.meta.json` | SHA-256 `f3c9f57f43645b30dcaa81eb419ba80819b6927423622ac307d8ceb886024230` |
| Previous metadata body | `liveId` is the Test id above. `textHash` is `ab07d71d…`, the WELCOME / `script.txt` hash |
| Production-owned legacy assets | `data/library/assets/` exists and contains no files |
| Versioned state | Absent: `migration.json`, `live-state.json`, `productions/`, `migration-work/`, `migration-attempt.json`, `data/live-journal/` |

Git tracks `script.txt` and the four files in `images/`. Git ignores `data/`, `script.previous.txt`, and `script.previous.txt.meta.json` (`.gitignore` lines 3–5). A clone does not contain the library. A backup made only from git is incomplete.

### Productions

Both files are valid UTF-8. Both parse to 10 slides. Both are 840 lines and 23,299 bytes. They differ on line 3 only.

| Title | Production id | Path | SHA-256 | Bytes equal `script.txt` |
| --- | --- | --- | --- | --- |
| `WELCOME TO ADAPT COMMUNITY NETWORK’S` | `2d0f0937-fc36-4d27-a31e-d047c2fd5623` | `data/library/scripts/2d0f0937-fc36-4d27-a31e-d047c2fd5623.txt` | `ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0` | Yes |
| `Test` | `ee04e849-90d4-4eeb-b2a6-562b06067a32` | `data/library/scripts/ee04e849-90d4-4eeb-b2a6-562b06067a32.txt` | `44f27efa4ff652dfe0be20d967cd385a149a8ee0f13e16b250caa5dc9d09ca47` | No |

The apostrophe in the WELCOME title is U+2019 (`’`), not ASCII `'`. Created `2026-11-16T01:00:42.086Z`. Test was created `2026-11-16T02:27:19.387Z` and updated `2026-11-16T03:38:54.178Z`. Index order is WELCOME, then Test.

### Image references

Each script contains the same five image lines. No `library:` references. No missing, extra, or conflicting files. Every referenced file is a regular file under `images/`.

| Script line | Reference | File SHA-256 | Bytes |
| --- | --- | --- | --- |
| 2 | `images/Title_Card.jpeg` | `da924c3aaf284c9e5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e` | 664,071 |
| 8 | `images/Cap_Back2.jpeg` | `ecf446be1bdc76be16dea4c24ba5188fa42c360c626927d247175820818bec1b` | 2,767,516 |
| 415 | `images/Cap_Back3.jpeg` | `11a6309fd758a094d8e5b4c82af9001163d8253ab2b173b5cad907068a8a41f5` | 2,716,072 |
| 602 | `images/Cap_Back4.jpeg` | `6d786f25b3ee1e49f5cb8a40625f4c152e58e416645059eef5578a4b21419410` | 2,763,972 |
| 771 | `images/Title_Card.jpeg` | same file as line 2 | 664,071 |

`images/` contains only those four files. Nothing in `images/` is unreferenced. Nothing referenced is missing.

## C. Legacy Live identity and library drift

**Verified.** The migration planner selects the live production by exact script bytes, not by `liveId`.

- One production matches `script.txt`: WELCOME.
- Test does not match.
- The planner warning is `live-id-drift`: stored `liveId` `ee04e849-90d4-4eeb-b2a6-562b06067a32`, actual production `2d0f0937-fc36-4d27-a31e-d047c2fd5623`, message “The library live id does not match the live script bytes and was ignored.”
- `safeToPrepare` is true for this inventory. `no-live-match` and `ambiguous-live-match` do not apply.
- `script.previous.txt.meta.json` also records the Test id, while its `textHash` and the previous file bytes are WELCOME. That metadata must not become a versioned previous activation.

**Proposal.** The first versioned live pointer names WELCOME’s migrated head (v2). `previousActivation` is null. Test remains a saved production and is not live. Restore Previous Live stays unavailable until a later real activation records a previous pair.

## D. Migration planner and stage compatibility

**Verified** against `library-migration-plan.js`, `library-migration-cli.js`, `library-migration-staging.js`, and the M7/M8 runtime. The planner is a pure function. The CLI refuses this repository before `inspect`.

What the existing tools will do with this inventory:

| Step | Behavior for this library |
| --- | --- |
| Production ids | Keep `2d0f0937-…` and `ee04e849-…`. |
| New ids | `prepare` allocates a migration id, a v1 id, a v2 id, and one asset id per distinct `images/` path, per production. Those UUIDs do not exist yet. |
| v1 | Exact original bytes. WELCOME v1 hash is `ab07d71d…`. Test v1 hash is `44f27efa…`. Policy `shared-images`. `parentVersionId` null. Origin `original`. |
| v2 | Created for both productions because each has legacy image lines. Origin `migrated`. Policy `production-assets`. Parent is that production’s v1. |
| Rewrite check | **Verified** in memory: v2 changes the five `@image` lines and no other line. Two Title Card lines in one production share one asset id. WELCOME and Test receive different asset ids, so the same JPEG is copied twice. |
| v2 hash | Depends on the asset UUIDs allocated at `prepare`. The placeholder ids used for this audit are not the ids M9B will allocate, and their hashes must not be copied into a checklist. |
| Saved head | v2 for both productions. |
| Live pointer | WELCOME’s v2. `origin: "migrated"`. |
| Marker | Schema 2, `state: "committed"`, `previousActivation: null`, `mirrorInstalled: false`, plus `migrationId`, `productionId`, `versionId`, `sourceScriptHash`, and `contentHash`. |
| Schema 3 | Must not be used. Schema 3 means a fresh library that has never had a show. Writing it here would hide WELCOME and Test behind the waiting state. |
| Legacy `liveId` | Recorded only as drift. It is not copied into `live-state.json`. |
| Image bytes | Copied from `images/` into each production’s asset directory during staging. The shared files stay in place. v1 still names `images/…`. v1’s text hash does not cover image bytes. |
| Initial installation | On an authorized boot, `mirrorInstalled: false` is `initialization-required`. `installVersionedLive` journals generation 1, `previousActivation: null`, writes `live-state.json`, replaces the `script.txt` mirror with the v2 bytes, then sets `mirrorInstalled: true`. |
| Mirror hash | After installation, `script.txt` will no longer be `ab07d71d…`. It will equal the committed v2 hash. Comparing the mirror with the pre-migration `script.txt` hash is expected to fail. |
| Interrupted prepare | A partial `migration-work/` tree and an attempt file can remain. `abort` removes an uncommitted attempt. `abort` refuses when a marker is already present. `commit` requires a verified READY plan, a matching fingerprint, and a matching plan hash. A changed source returns `source-changed` and does not commit. |
| Pending journal | Startup refuses `pending-journal` and leaves the journal in place. |
| Missing live pointer after `mirrorInstalled: true` | `missing-live-state`. The runtime does not rebuild it and does not fall through to the M8 waiting state. |

**Verified mismatch.** `library-migration-cli.js` still says “A trusted production root arrives in M7.” M7 and M8 did not add that root. Both the CLI and `authorizeVersionedFixture` still reject every path outside a dedicated OS-temp directory, including this repository. The schema 2 installer and the M8 schema 3 waiting state are separate. This library follows schema 2.

Synthetic fixture tests do not prove these two files and four JPEGs migrate. That is the M9B rehearsal.

## E. Persistent-root authorization dependencies

**Verified** restrictions that stop a normal persistent installation from starting:

1. `detectStorageMode` returns `supported: false` for every committed marker, including schema 2 and schema 3.
2. `server.js` throws `unsupported-versioned-storage` and does not listen unless `fixtureAuthorizationAccepted` returns true.
3. `authorizeVersionedFixture` requires a real directory under `os.tmpdir()`, outside the repository realpath, with no symlink in the library, script, previous-script, metadata, or journal paths.
4. The CLI `authorizeRoot` applies the same temp-directory rule and returns `unsafe-root` for this repository.
5. No environment variable, HTTP header, or `?role=` query authorizes versioned startup.
6. `allowFaults` only enables test crash points on a server that is already fixture-authorized.
7. The version store and the live installer also refuse this repository as a write root.
8. One versioned service queue owns a library realpath. A second writer in the same process waits. A second process is not fenced by that queue.
9. Journal recovery runs at startup and will not delete a pending or corrupt journal.
10. Live state, production assets, and the script mirror are files on the library root. `SCRIPT_LIBRARY_DIR`, `SCRIPT_FILE`, and `PREVIOUS_SCRIPT_FILE` can move those paths for Legacy. They do not authorize Versioned mode.
11. Shutdown is process exit plus `server.close` on the fixture helper. There is no service unit, PID file, or health check in the tree.
12. Backup and rollback are not implemented as commands.

**Proposal for M9B/M9C.** Add `authorizeVersionedPersistentRoot` beside the fixture authorizer. Do not widen `authorizeVersionedFixture`. Do not add `PROMPTER_VERSIONED=1` or any variable whose value is an arbitrary writable path.

The persistent token is a frozen object created only from an authorization file that lives outside the git checkout. Suggested file fields:

- `schema`
- `purpose: "adapt-persistent"`
- canonical `root` realpath
- canonical `libraryDir`, `scriptFile`, `previousFile`, and `journalDir`
- `migrationId` expected in the committed marker
- `confirmCheckoutRoot` only when ADAPT deliberately keeps storage inside the checkout

Startup accepts the token only when every realpath matches, symlink walks stay inside that root, and the marker’s `migrationId` matches the file. HTTP cannot supply the token. A fixture token still cannot open the repository. A persistent token cannot open a different directory than the file names.

**Decision needed.** Where the durable root lives. Today’s files are inside the checkout, and `data/` is gitignored. Preferred layout: move the operating copies to a directory outside the checkout, such as the pattern already described for `SCRIPT_LIBRARY_DIR`, and point the authorization file at that directory. Keeping the checkout as the root is possible only with `confirmCheckoutRoot` and an operator record, because a git clean or a fresh deploy directory will not contain `data/`.

**Not tested.** The persistent authorizer does not exist. M9B can rehearse without it by using a temp-directory copy and the current fixture token.

## F. Deployment infrastructure requirements

**Verified** from the tree and `README.md`:

- Entry point: `node server.js` (`npm start`). `package.json` has no `engines` field.
- This audit machine ran Node `v24.18.0`. That is not a production pin.
- The process listens on `0.0.0.0` and `PORT` (default 3000).
- HTTP and WebSocket share that one Node server (`ws` attached to the HTTP server).
- There is no Dockerfile, process manager, reverse-proxy config, TLS config, DNS record, or hosting account in the repository.
- The app cannot run on static hosting. It writes files and keeps a WebSocket open.
- Legacy storage paths are `script.txt`, `script.previous.txt`, `script.previous.txt.meta.json`, and `data/library/` beside the script unless the environment overrides them.
- Environment variables that exist: `PORT`, `SCRIPT_FILE`, `PREVIOUS_SCRIPT_FILE`, `SCRIPT_LIBRARY_DIR`, `PROMPTER_STAFF_TOKEN`, `PROMPTER_IMAGE_MAX_BYTES` (default 10 MB). None of them selects versioned storage.
- README operating model: devices on one Wi-Fi network. The staff token is one shared passphrase. `POST /script` stays open when the token is set.
- Logs are process stdout. Script text is not intended to be logged. There is no metrics or alerting config.

**Decision needed.** Host, Node version, process supervisor, disk that survives deploy, HTTPS terminator, public or private DNS, and who receives process logs. No provider has been chosen here, and none is assumed.

**Proposal.** The host is a long-running Node process with a mounted disk for the script files, `data/library`, `images/`, and `data/live-journal`. If browsers use HTTPS, the proxy must upgrade WebSockets. A VM, a container with a volume, or a supervised process on a machine ADAPT controls can meet that. GitHub Pages, a static host, and a stateless function cannot.

**Not tested.** No deployment of this application was inspected or started for M9A.

## G. HTTP and WebSocket access-control matrix

**Verified** from `server/http-routes.js`, `server/versioned-http-routes.js`, and `server/live-socket.js`. `?role=controller` changes the browser only. Staff checks use `X-Staff-Token` and `PROMPTER_STAFF_TOKEN`. An empty token makes every staff route open.

“Staff” below means the header matches a configured token. “Open” means the route runs with no token.

| Route or message | Effect | Today | If the token is unset |
| --- | --- | --- | --- |
| `GET /` and allowlisted `/public`, `/fonts`, root JS/CSS | Read the application shell | Open | Open |
| `GET /images/<file>` | Read every shared JPEG under `images/` | Open | Open |
| `GET /script` | Read the live script | Open | Open |
| `GET /script/previous` | Read the previous live script | Open | Open |
| `POST /script` | Publish or replace the live script, and update the matching library row when headers match | Open | Open |
| `POST /script` with `X-Restore-Previous: 1` | Restore the previous live script | Open | Open |
| `GET /api/library/access` | Report whether a staff token is configured | Open | Open |
| `GET /api/library`, `GET /api/library/:id` | Read titles and saved scripts | Staff | Open |
| `POST /api/library` | Create a production | Staff | Open |
| `PUT /api/library/:id` | Rename or save | Staff | Open |
| `POST /api/library/:id/live` | Set as Live | Staff | Open |
| Asset `GET` / `POST` / `DELETE` under `/api/library/:id/assets` | List, upload, or delete production images | Staff | Open |
| `GET /api/live/assets/...` | Read an image referenced by the live script | Open | Open |
| Version history `GET` | Read committed versions (versioned server) | Staff | Open |
| `POST .../versions/:versionId/restore` | New saved head from history (versioned server) | Staff | Open |
| WebSocket connect | Receive the current script and cue | Open | Open |
| WebSocket `navigate`, `goto` | Move the shared cue for every client | Open | Open |
| WebSocket `reloadScript` | Reload the live script from disk into memory | Open | Open |

`data/library/` and the journal are not in the static allowlist. Unpublished production files are not served as static files. Shared files in `images/` are served to anyone who can reach the port, including after migration, for as long as those files remain beside the server.

CORS, an unpublished path, and `?role=` are not authorization.

## H. Required interim protections before S2B

Security S2B stays a later branch. M9C still has to keep unauthenticated writes off the public internet.

**Blocker.** A public Audience page and a protected Controller cannot be separated with the current server. Audience needs `GET /`, `GET /script`, live image reads, and a WebSocket that delivers `script` and `state`. The same WebSocket accepts `navigate`, `goto`, and `reloadScript` from any connected client. `POST /script` is on the same origin and has no staff check. An HTTP proxy that blocks `POST` and `/api/library` while allowing the WebSocket still leaves cue control open.

**Proposal, and the only interim control that covers HTTP and WebSocket together.** Place the whole process on a network where untrusted clients cannot open the port. Acceptable shapes, once ADAPT picks one: a dedicated show network with no guest route to the port, a VPN, or an identity-aware gateway that requires a login before any HTTP or WebSocket connection. Localhost-only does not meet a multi-device rehearsal unless every screen is that same machine. Guest Wi-Fi is not a boundary.

**Not tested.** No firewall, VPN, or gateway was configured in M9A.

External refusal test, to be recorded before GO:

1. From a network that must not have access, a TCP connection to the host and port fails or times out.
2. From that same network, `GET /script`, `POST /script`, and a WebSocket upgrade all fail.
3. From a device that should have access, Audience receives the live cue.
4. Record source address, time, and result for each attempt.
5. If step 2 succeeds, the launch is NO-GO.

**Blocker** if ADAPT needs Audience or Actor devices on the public internet before S2B. That shape waits for application-level authorization, or for a gateway that can prove it drops `navigate`, `goto`, `reloadScript`, and `POST /script` while still delivering the show. No such gateway is specified or tested here.

Set `PROMPTER_STAFF_TOKEN` for the library even on the private network. The token does not close `POST /script` or cue commands. Keep the token out of git and out of this document.

## I. Backup and consistency procedure

**Proposal.** No backup was created in M9A.

Freeze writes first. Stop the Node process. Confirm the port has no listener. Confirm no second `node server.js` is running against this directory. Copy only after that. A copy taken while the process is writing can mix an old `script.txt` with a new index.

Include, and record absence where a path is missing:

- `script.txt`
- `script.previous.txt`
- `script.previous.txt.meta.json`
- `data/library/index.json`
- `data/library/scripts/`
- `data/library/assets/`
- `images/`
- `data/live-journal/` if it exists
- `data/library/migration.json`, `live-state.json`, `productions/`, `migration-work/`, and `migration-attempt.json` if they exist

Store the copy outside the repository and outside the OS temp directory used for fixtures. Suggested name: `adapt-pre-migration-<UTC timestamp>`. Produce a SHA-256 manifest of every file. Verify by reading the copy and computing the hashes again. The archive existing is not validation.

Restore test: extract into a third directory and require a byte-for-byte manifest match. Do not extract onto the live root during that test.

**Decision needed.** Who holds the backup, where it is stored, and how long it is kept. Proposal: the named ADAPT technical owner holds it; keep the pre-migration copy until ADAPT records that a return to Legacy is no longer wanted; keep at least one post-migration backup from the first operating week. Do not commit the backup or the staff token.

**Not tested.** No restore drill has been run on this data.

## J. Rollback scenarios and data-loss boundaries

Legacy and versioned runtimes must not write the same root. Stop every server before copy, commit, install, or restore.

| When it fails | Recovery |
| --- | --- |
| Before staging | The live tree is unchanged. Start the Legacy server again. |
| During staging, before a marker | `abort` on the rehearsal or, on the real root, restore is not required if `abort` reports the attempt removed and a fresh manifest matches the pre-migration manifest. If the manifest differs, restore the backup onto the stopped root. |
| `commit` refused | The marker is absent. Treat it as the staging row. |
| Marker committed, installer has not finished | Today’s server will not listen. Restore the pre-migration backup onto the stopped root. That restore removes the marker, live pointer, and production tree by replacing the tree. Then start Legacy. |
| Installer committed, operators have not edited | Same backup restore, after the process is stopped. The new mirror hash is expected and is not by itself a reason to keep the new tree. |
| Operators have published, saved, or set a show live | A Legacy snapshot drops those edits. Stop the process. The technical owner states which edits would be lost. A named ADAPT approver decides in writing before the restore. There is no automatic merge. |

Do not recover by deleting `migration.json` or by editing `liveId`. After the marker exists, the supported return to the old show is a restore of the consistent backup with no server running.

A pending or corrupt journal is evidence. Leave it in place while diagnosing. Startup will refuse it. Deleting it to force a boot can hide a half-written live pointer.

## K. M9B isolated real-data rehearsal plan

**Not tested.** Do not run this during M9A.

The rehearsal copy must sit in its own subdirectory of `os.tmpdir()`, outside this repository. The current CLI and fixture authorizer accept that location and reject this checkout. No persistent-root code is required for M9B. A generic path outside the temp directory will be rejected until the M9C authorizer exists.

Copy procedure:

1. Stop any server that has this checkout open. Confirm the source hashes in section B.
2. Create a new temp directory. Copy `script.txt`, `script.previous.txt`, `script.previous.txt.meta.json`, `data/library/`, and `images/`. Do not copy `node_modules` or `.git`.
3. Write a manifest beside the copy, labeled disposable rehearsal data. Re-hash the copy against section B. Refuse to continue on any mismatch.
4. Point the rehearsal root only at that temp directory.

Then, only on the copy:

1. `--dry-run`: expect `safeToPrepare`, live production WELCOME, `live-id-drift` toward Test, four legacy images on each production, v1 count 2, v2 count 2, and no blocking image errors.
2. `--prepare`, then `--verify`: READY, v1 bytes equal the source files, v2 differs only on image lines, eight owned image files (four per production), Title Card shared inside each production.
3. `--commit` on the copy only. Read schema 2, `mirrorInstalled: false`, `previousActivation: null`, production id WELCOME, version id equal to WELCOME’s v2.
4. Start `createPrompterServer` with `authorizeVersionedFixture` for that temp root. Expect installation to finish before listen. Generation is 1. `previousActivation` is null. Memory text is the v2 script. The first cue matches the migrated WELCOME show. `live-state.json` does not name Test.
5. `GET /script` returns the v2 bytes. `GET /script/previous` is `no-previous-activation`.
6. Render the four production-owned images through the live asset route. Confirm they match the source JPEG hashes.
7. Create a production, save a version, set it live, and publish. Confirm each one is explicit and journaled.
8. Open version history, preview an older version, and restore a saved version. Confirm restore moves the saved head and does not by itself replace the live pointer.
9. Connect Controller, Actor, and Audience. Move a cue and confirm the audience follows. Browse on the actor and return to live.
10. Restart the process and confirm the same generation and script return.
11. Inject one committed-journal crash and one pending-journal refusal, using the existing fault points. Pending evidence stays. The pending case must not boot.
12. Take a backup of the rehearsal root, change a disposable file, restore the backup into another temp directory, and match manifests.
13. Re-hash this repository against section B. Any difference stops the rehearsal.

M9B is not evidence for the real root until step 13 passes. Fixture tests already in the repo are not a substitute for steps 1–13.

## L. M9C operational migration runbook outline

**Not tested.** M9C is a handoff, not a successful script exit.

GO requires every item in section M. NO-GO if any **Blocker** in section O is open, if the source manifest differs from section B, if the rehearsal in section K has not passed, or if the external-client test in section H fails.

Order:

1. Name the technical owner and the rollback approver. Open the maintenance window.
2. Confirm the host, the persistent disk, the authorization file, and the network boundary. Set the staff token outside git.
3. Stop the Legacy process and any other writer. Freeze writes.
4. Take the section I backup and pass the isolated restore test.
5. Re-hash the live tree against section B.
6. Run the migration CLI against the authorized persistent root: dry-run, prepare, verify, commit. The marker is schema 2. `previousActivation` is null.
7. Start the persistent versioned server once. The installer writes generation 1 and the v2 mirror. Record the new `script.txt` hash and confirm it equals WELCOME’s committed v2 hash.
8. Smoke-test HTTP and WebSocket: Audience cue, actor private browse and Return to Live, controller next/previous, all four images, create, save, publish, set live, history preview, and historical restore.
9. Confirm Restore Previous Live is unavailable immediately after install, then available after one real publish or set-live. A null previous activation is the correct initial result.
10. Restart the process. Confirm the show and generation return without a second migration.
11. Leave the external-client refusal test result in the operator log.
12. ADAPT accepts the show in writing, or the rollback approver orders the section J restore.

The technical owner can stop before step 6 without a backup restore when the manifest still matches. After step 6, only the stopped-process backup restore returns to Legacy. After step 8 has written new operator edits, the rollback approver must accept the data loss in section J first.

## M. ADAPT handoff and operational acceptance checklist

Each line is measurable. All are **Not tested** until M9C records a result.

- Maintenance window is agreed, with a start and an end.
- Technical owner and rollback approver are named people.
- Host, Node version, supervisor, and restart policy are written down.
- Persistent disk is the directory in the authorization file, and it survives a process restart.
- Backup location and retention are written down. The pre-migration manifest matches section B, and the isolated restore test matched.
- Interim network test in section H passed on the day of the cutover.
- `PROMPTER_STAFF_TOKEN` is set. The token is not in the repository.
- Dry-run on the persistent root reports WELCOME as the only live match and reports the Test `liveId` as drift.
- Committed marker is schema 2, `mirrorInstalled` becomes true only after installation, and `previousActivation` is null before any later edit.
- Live production id is `2d0f0937-fc36-4d27-a31e-d047c2fd5623`. Live version is that production’s v2. Test is present and not live.
- Controller, Actor, and Audience show the migrated WELCOME cues. Images for all four files render.
- Create, save, publish, set live, history, and historical restore each behave as they do on the M9B copy.
- Restart keeps the show.
- Monitoring is a person watching the process log through the first performance, until ADAPT names something else.
- Recovery steps from section J are printed with the backup id.
- ADAPT signs acceptance, or the rollback approver signs a restore.

## N. Open decisions and ownership

| Decision | Owner | Status |
| --- | --- | --- |
| Who is the technical owner and who may approve a rollback | ADAPT | **Decision needed** |
| Host, Node version, supervisor, disk, TLS, DNS | ADAPT and IT | **Decision needed** |
| Keep storage in the checkout, or move it outside git | ADAPT and IT | **Decision needed**. Proposal: move it. |
| Who stores the pre-migration backup, where, and for how long | ADAPT | **Decision needed** |
| Must Audience or Actor devices use the public internet before S2B | ADAPT | **Decision needed**. Public access is a **Blocker** until S2B. |
| Which private-network or gateway product enforces section H | IT | **Decision needed** |
| Staff token value and who knows it | ADAPT | **Decision needed**. Do not store it in git. |
| When S2B starts | After M9C acceptance and a separate PR | Sequencing is decided. Implementation is not this branch. |

No hosting credential, URL, approval, or staff-token value was available, and none is invented here.

## O. Risks and blockers

| Severity | Item | Class |
| --- | --- | --- |
| Blocker for M9C | Committing a marker with the current binary makes `server.js` refuse to listen. Persistent-root authorization has to ship before that commit. | **Blocker** |
| Blocker for public M9C | `POST /script`, Restore Previous, and WebSocket `navigate` / `goto` / `reloadScript` have no staff check. Path filtering does not close the WebSocket. | **Blocker** |
| Blocker for M9C | No tested backup, no named backup owner, no restore drill on this data. | **Blocker** until section I is done |
| Blocker for M9C | Host and durable disk are unknown. `data/` is gitignored, so a fresh deploy directory loses the library. | **Decision needed** |
| High | Two processes can write one root. The in-process queue does not stop a second OS process. Cutover must be single-writer. | **Verified** gap |
| High | After operators edit the versioned show, a Legacy restore discards those edits. | **Proposal** in section J |
| High | `script.txt` hash changes when the v2 mirror is installed. An operator who “repairs” it back to `ab07d71d…` breaks the mirror check. | **Verified** |
| Medium | Legacy `liveId` and previous metadata name Test while the bytes are WELCOME. Following `liveId` would put the wrong show on stage. The planner does not follow it. | **Verified** |
| Medium | v1 keeps shared `images/` paths. Replacing a shared JPEG later changes what v1 displays. v1 is not the live head. | **Verified** |
| Medium | Shared `images/` files stay publicly readable on the open static route. | **Verified** |
| Medium | CLI error text still says the trusted root arrives in M7. | **Verified** stale message. Leave it until the persistent authorizer replaces that path. |
| Low | Schema 3 exists for an empty library. Using it on ADAPT would show the waiting state and hide both productions. | **Verified** contract |
| Low | Node is unpinned. | **Decision needed** |

Synthetic tests, including the 367 Node tests and 57 browser tests, do not retire the M9C blockers.

## P. M9A readiness verdict

**PASS WITH LIMITATIONS.**

The real library was inventoried without mutation. Live identity is WELCOME by bytes, with Test recorded only as drift. Schema 2 matches the runtime, and schema 3 must stay unused for this library. Backup, rollback, M9B, and M9C are specified as procedures and have not been executed. Versioned startup is still fixture-only. Public launch is blocked until writes and cue commands are actually unreachable or until S2B. Private-network launch waits on the decisions in section N and on the tests in sections H, I, and K.

## Security S2B separation

S2B is not part of this branch and is not part of M9A, M9B, or M9C.

After M9C is accepted and the versioned library is merged:

1. Branch `feat/security-s2b` from the stable default branch.
2. Add application-level authorization there.
3. Open a separate pull request.
4. Test the staff-code and permission changes with ADAPT users.

Infrastructure protection in section H is required for M9C even though S2B is deferred.
