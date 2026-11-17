# M9B — Real-Data Copy Migration Dry Run

Status: rehearsal only. This run copied real ADAPT Legacy storage into disposable directories under the OS temporary directory, migrated that copy, and restored a separate copy of the pre-migration snapshot. It did not migrate the repository, enable persistent-root versioned writes, deploy a server, or implement Security S2B.

Labels used below:

- **Verified** — observed on this rehearsal, against the source tree or a disposable copy.
- **This rehearsal only** — identifiers allocated by this prepare. A later prepare assigns new ids and a different v2 hash.
- **Limitation** — the rehearsal succeeded and the limitation remains for M9C.
- **Decision needed** — ADAPT or IT must choose before M9C.
- **Blocker** — M9C must not pass this point until the condition is met.

Rehearsal base: `d254578` on `feat/versioned-script-library` (`docs: audit real ADAPT migration readiness`). The working tree was clean before the rehearsal. The only repository file added by M9B is this document. No automated test was added.

M9B verdict: **PASS WITH LIMITATIONS**. See section U.

## A. Executive outcome

**Verified.** A consistent copy of the ten Legacy files was taken, backed up, planned, prepared, committed, and installed under `os.tmpdir()`. The planner selected WELCOME as the unique live production and recorded the stored `liveId` as `live-id-drift`. Both productions kept their original ids and exact titles. Each original script became immutable v1. Each received a v2 whose only text changes are five `library:` image references, backed by four production-owned JPEG copies. Eight owned image files were written. No asset id was shared across productions. `previousActivation` stayed null. The committed marker is schema 2. Initial installation wrote generation 1, pointed at WELCOME v2, and set `mirrorInstalled` to true only after the mirror matched that v2.

**Verified.** An authorized fixture server on `127.0.0.1` loaded that show. Library, image, Controller, Actor, and Audience checks passed on the copy. Version History preview left Live unchanged. Restoring WELCOME v1 was refused. A later saved-only restore did not activate. Crash clones recovered committed journals and refused pending, corrupt, and damaged states. A clean restart kept Live State. Restoring the rehearsal backup into a separate temporary directory served the original WELCOME bytes through the Legacy path.

**Verified.** The source manifest after the rehearsal matched the manifest taken before the copy. `detectStorageMode` on the source still returns `mode: "legacy"`. No marker, Live State, productions tree, staging directory, or journal appeared in the source.

**Limitation.** This is not the M9C production backup, not a public access-control test, and not an operational launch. A second operating-system process can still open the same root. Public Audience launch stays blocked while `POST /script` and WebSocket cue commands remain unauthenticated.

## B. Exact source snapshot and hash verification

Read on 16 November 2026 from the working tree at `d254578`. Each hash below was recomputed from the file bytes before copying. The values match `docs/migration/m9a-readiness.md`.

The M9B request transcribed Cap_Back4 as `6d786f25b3ee1e49f5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e`. That string is 63 hex characters and mixes the M9A Cap_Back4 prefix with the Title Card hash. It was not used. The file bytes match the M9A value in the table.

| Path | SHA-256 | Bytes |
| --- | --- | --- |
| `script.txt` | `ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0` | 23,299 |
| `script.previous.txt` | `ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0` | 23,299 |
| `script.previous.txt.meta.json` | `f3c9f57f43645b30dcaa81eb419ba80819b6927423622ac307d8ceb886024230` | metadata file |
| `data/library/index.json` | `ee9d8f81ff66b174d6806bc5a43250449aae8dc21b6799e0d9d95dcf633762f7` | index file |
| WELCOME script | `ab07d71d986cb25fe9a3afc3de8077a359a2f1356bb765d9e948e252a419e5d0` | 23,299 |
| Test script | `44f27efa4ff652dfe0be20d967cd385a149a8ee0f13e16b250caa5dc9d09ca47` | 23,299 |
| `images/Title_Card.jpeg` | `da924c3aaf284c9e5f9eb65bd9ec78ac11d13293b39626e362c04e00c80d508e` | 664,071 |
| `images/Cap_Back2.jpeg` | `ecf446be1bdc76be16dea4c24ba5188fa42c360c626927d247175820818bec1b` | 2,767,516 |
| `images/Cap_Back3.jpeg` | `11a6309fd758a094d8e5b4c82af9001163d8253ab2b173b5cad907068a8a41f5` | 2,716,072 |
| `images/Cap_Back4.jpeg` | `6d786f25b3ee1e49f5cb8a40625f4c152e58e416645059eef5578a4b21419410` | 2,763,972 |

WELCOME id `2d0f0937-fc36-4d27-a31e-d047c2fd5623`, title `WELCOME TO ADAPT COMMUNITY NETWORK’S` (U+2019). Test id `ee04e849-90d4-4eeb-b2a6-562b06067a32`, title `Test`. Both files are 840 lines. They differ on line 3 only. `script.txt` and `script.previous.txt` byte-match WELCOME. Each script has five image lines and four distinct JPEG files. `data/library/assets/` exists and is empty. `data/live-journal/` is absent, so there was no journal to copy. The previous-script metadata records the Test id and the WELCOME text hash. It was copied and was not turned into a previous activation.

The same ten-file manifest was recomputed after the copy and again after the rehearsal. Both matched the initial manifest. No source file in the table changed during the run.

## C. Temporary-copy isolation evidence

**Verified.** The rehearsal parent was created with `fs.mkdtemp` under `os.tmpdir()`. Its canonical path was:

`/private/var/folders/cj/02x8m1ds1v5fz36lq4fp3y0w0000gn/T/adapt-m9b-ztuLrA`

That path is under the canonical temporary directory and outside the canonical repository root `/Users/lisawang/Cornell/MakerLab/ADAPT-stage-prompter`. Separate children held the pre-migration snapshot, the rehearsal backup, and the active migration directory. Crash, partial-prepare, and rollback directories were further siblings, not the active tree.

Each of the ten source paths was `lstat`ed. Each was a regular file. Copying used `fs.copyFileSync` and did not rewrite newlines or image bytes. Walking a rehearsal directory refused a symlink or a non-file node. The snapshot manifest contained exactly those ten relative paths. The copy also created an empty `data/library/assets/` directory so the existing empty source directory had a counterpart. That directory added no file to the manifest.

No migration command, installer, recovery call, or Versioned Server was pointed at the repository root. The source root was not passed as a writable destination. No archive, report, or fixture marker was written inside the real library. Source permissions were not changed. No real ADAPT server was stopped or restarted.

The disposable trees, including the rehearsal runner and its JSON log, were removed after this report was written. They were not a retained production backup.

## D. Pre-migration rehearsal backup

**Verified.** Before `prepare`, the snapshot was copied into a sibling backup directory. The backup walk preserved the same ten relative paths. Its SHA-256 manifest matched the source snapshot and the snapshot taken before migration. The backup directory was not the directory later passed to prepare, commit, or install.

**Limitation.** This backup proves the rehearsal can return its own copy to the original Legacy bytes. It is not the production backup M9C requires, and it was not kept.

## E. Migration planner findings

**Verified.** `runMigration({ command: 'dry-run', root: <active copy> })` ran against the disposable active directory.

| Result | Value |
| --- | --- |
| Live production | WELCOME `2d0f0937-fc36-4d27-a31e-d047c2fd5623` |
| Stored library `liveId` | Test `ee04e849-90d4-4eeb-b2a6-562b06067a32` |
| `liveIdDrift` | true |
| Warning | `live-id-drift`: the library live id does not match the live script bytes and was ignored |
| Productions | 2, with the original titles and original content hashes |
| Legacy images named per production | Title Card, Cap_Back2, Cap_Back3, Cap_Back4 |

The dry run was read-only on the copy. It did not invent a previous activation.

## F. Legacy Live ID drift and the WELCOME match

**Verified.** Exact script bytes select WELCOME. Test does not match `script.txt`. The stored `liveId` is drift, and the planner ignored it. Previous-script metadata also names Test while its file bytes and `textHash` are WELCOME. Installation left `previousActivation` null. `GET /script/previous` on the installed copy returned 404 `no-previous-activation`.

## G. Generated migration, version, and asset identities

**This rehearsal only.** Prepare allocated these ids. M9C prepare will allocate different ones, and the v2 hashes will differ because they include the asset ids.

| Item | Identity |
| --- | --- |
| Migration id | `82490204-54bf-42a8-a886-54d7fc967d45` |
| Plan hash | `5ee00cb29a4f89c09a9120cd7d491cd897dfdb812eae5a7658b89cb1b53f45a5` |
| WELCOME v1 | `a5ad087d-4bf7-4188-893c-087e82baaae6`, hash `ab07d71d…e5d0` |
| WELCOME v2 | `8705f283-c78a-4e8c-b420-2994ade60d74`, hash `acdcaaeadfe5225b3e6020d141965b0f2a2df945b7317621a8df4466ae992c62` |
| Test v1 | `6f9967a4-fb20-445e-a1bb-3b531a1402b9`, hash `44f27efa…ca47` |
| Test v2 | `165b1a0c-5d7f-4ae9-813a-fdccd9a2fa93`, hash `040f5c3c9641fe3dbc03ee3e7fae89da89dfea4dd92dd89990dc1399b975560e` |

WELCOME owned assets:

| Legacy file | Asset id | Bytes |
| --- | --- | --- |
| Cap_Back2 | `f1af8bac-c97a-4703-9d9d-ef281bff96c5` | 2,767,516 |
| Cap_Back3 | `3ff774a5-0774-4d4c-8f7f-a39e1e306541` | 2,716,072 |
| Cap_Back4 | `b1dcd0c8-bd4f-405b-9d5b-9a896317b230` | 2,763,972 |
| Title Card | `cbe5bda5-d9e5-4b4c-a18f-aff01f91a62f` | 664,071 |

Test owned assets:

| Legacy file | Asset id | Bytes |
| --- | --- | --- |
| Cap_Back2 | `8f4ae923-ccf2-4501-b3d3-01e9fbb98da1` | 2,767,516 |
| Cap_Back3 | `1c426821-077d-45bf-a6e7-78a34441926a` | 2,716,072 |
| Cap_Back4 | `340919b7-69b9-43d7-b494-90badab687b5` | 2,763,972 |
| Title Card | `f349570e-7343-417d-8ea2-b4ca2fcd071d` | 664,071 |

The eight asset ids are distinct. Stored owned-file hashes equal the source JPEG hashes. Each manifest entry records `ext: "jpg"`, `mime: "image/jpeg"`, `byteLength` equal to the file length, and `contentHash` equal to the file hash. Files are `{assetId}.jpg`.

## H. Prepared staging verification

**Verified.** An interrupted prepare on a separate copy, with `failAt: 'asset'`, threw `injected-failure`. Verify on that copy returned `ready: false` and `missing-file`. It was not treated as READY.

Prepare on the active copy returned ok. Verify returned `ready: true` and attempt state `ready`.

For each production, before commit, under `data/library/migration-work/productions/`:

- v1 bytes equal the legacy script file and the M9A hash.
- v2 differs only on `@image` lines.
- v2 contains five `library:<productionId>/<assetId>` references and four distinct asset ids.
- Both Title Card lines in that production use that production’s Title Card asset.
- The saved head is v2.
- The production title is unchanged.
- The original production ids remain the directory ids.
- No third production was staged by the migration.

Legacy `script.txt`, both library scripts, the index, and the shared JPEGs were still the source hashes at this point. No `live-state.json` existed yet.

## I. Committed schema 2 marker

**Verified.** Commit on the active copy returned `committed: true` and `activated: false`. `data/library/migration.json` was:

| Field | Value |
| --- | --- |
| `schema` | 2 |
| `state` | `committed` |
| `migrationId` | `82490204-54bf-42a8-a886-54d7fc967d45` |
| `productionId` | WELCOME |
| `versionId` | WELCOME v2 `8705f283-c78a-4e8c-b420-2994ade60d74` |
| `previousActivation` | null |
| `sourceScriptHash` | `ab07d71d…e5d0` |
| `contentHash` | `acdcaaeadfe5225b3e6020d141965b0f2a2df945b7317621a8df4466ae992c62` |
| `mirrorInstalled` | false |

Schema 3 was not written. `mirrorInstalled` stayed false until installation. `script.txt` was still the original WELCOME hash. Both v1 and v2 versions and their assets were present after publish. The legacy script files and shared images remained.

## J. Initial Live State and WELCOME v2

**Verified.** `installVersionedLive` on the committed copy selected WELCOME v2.

| Check | Result |
| --- | --- |
| Live State schema | 1 |
| Generation | 1 |
| Production | WELCOME |
| Version | `8705f283-c78a-4e8c-b420-2994ade60d74` |
| `contentHash` and mirror hash | `acdcaaeadfe5225b3e6020d141965b0f2a2df945b7317621a8df4466ae992c62` |
| `previousActivation` | null |
| `mirrorInstalled` after install | true |

The mirror hash is the generated v2 hash. It is not the original `ab07d71d…` hash, because the image lines now name owned assets. The legacy library script files and the shared JPEGs were unchanged by installation. The stored Test `liveId` was not adopted.

## K. HTTP and WebSocket functional results

**Verified.** `createPrompterServer` ran with `authorizeVersionedFixture` for the active temporary root. The listen address was `127.0.0.1` on an ephemeral port. One server process owned the active root during the functional pass. Startup completed with memory live id WELCOME, revision equal to the v2 hash, `awaitingLive` false, and 10 slides.

The first WebSocket messages were `script` then `state`. The script frame carried the WELCOME id and the v2 revision.

| Request | Result |
| --- | --- |
| `GET /api/library` with the fixture staff token | 200, both titles, `liveId` WELCOME |
| `GET /api/library` without the token | 401 |
| Production detail | WELCOME and Test saved heads are their v2 ids |
| `GET /script` | 200, body hash is the WELCOME v2 hash |
| `GET /script/previous` | 404 `no-previous-activation` |
| Four WELCOME live assets | 200, bytes match the source JPEGs |
| A Test-owned asset while WELCOME is live | 404 |
| Set as Live with a stale revision | 409 |
| `GET /api/library/not-a-uuid` | 400 |
| WELCOME version list | 200, length 2 |
| Create “Rehearsal Extra” | 201, `activated` false, id `ac4bc88c-9bb6-4a38-aa4b-9919cf8727f8` |
| Upload one PNG to that production | 201, asset `40286e3d-e68f-4fc1-b3f8-5dc7de8edcd9`, stored bytes match |
| Save a new version of that production | 200, new version id, Live stayed WELCOME |
| Set Test live | 200, generation 2, `resetPosition` true, `liveId` Test |
| `POST /script` publish of Test plus one trailing rehearsal line, no staff token | 200, `libraryUpdated` true, `resetPosition` false, slide and line unchanged, generation 3, `previousActivation.versionId` is Test v2 |
| `POST /script` with `X-Restore-Previous: 1` | 200, version id Test v2, generation 4 |
| Restore Test v2 as a new saved head | 201, `activated` is not true, saved head changed, Live version stayed Test v2 |

A raw WebSocket `navigate` with `direction: "next"` was accepted on the loopback server with no staff check. That observation is recorded in section R. It is not a public-boundary test.

## L. Controller, Actor, and Audience browser results

**Verified.** Chrome, through Playwright, opened controller, actor, and audience pages against the loopback server. The fixture staff token was placed in `sessionStorage` for those pages. The connecting overlay hid on each page.

The opening cue is the title image, so the controller’s current-line count was 0 and the actor’s current-line count before browsing was 0. The audience page rendered one live image. The controller was not in the waiting state. Actor and audience pages hid the controller chrome.

Actor Next set the status to `BROWSING`. Return to Live set it to `FOLLOWING LIVE`.

The library listed both original titles. Version History for WELCOME opened. The shared-image card showed “Uses a shared image.” Preview opened, the status said the show was not changed, and the in-memory revision stayed WELCOME v2.

After one live Next, the audience rendered the first cue line. Set as Live to Test, without reloading the pages, showed the title-image overlay on the audience and actor pages. Both image addresses contained Test’s Title Card asset `f349570e-7343-417d-8ea2-b4ca2fcd071d`.

## M. Image ownership and rendering

**Verified.** Each production’s five image directives became valid `library:` references in v2. The two Title Card directives inside one production share that production’s Title Card asset. WELCOME and Test received different asset ids for the same legacy file. Owned JPEG hashes match the four source files. Public `GET /api/live/assets/...` returned the four assets referenced by the active WELCOME script and returned 404 for a Test-owned asset that the active script does not reference. The audience rendered the active title image, then followed Test’s title image after Set as Live.

## N. Version History, preview, and saved restore

**Verified.** WELCOME history listed two committed versions. Preview of WELCOME v1 returned 200 with `legacyImagePolicy: "shared-images"`, `contentHash` `ab07d71d…e5d0`, and a non-empty `version.text`. The live revision stayed WELCOME v2.

`POST` restore of WELCOME v1 returned 400 `legacy-image`. Live did not move. The existing route map uses 400 for that code.

After Test had a newer saved head, restoring Test v2 created a new saved head and left the live version at Test v2. The browser history preview likewise left Live unchanged.

## O. Crash recovery

**Verified.** Destructive cases used cloned temporary trees. The successful active tree was not the only copy used for those faults. Journals live under `data/live-journal/versioned-live/`. `X-Test-Fail-At` was available because the fixture authorization allowed faults.

| Case | Observed result |
| --- | --- |
| Install `failAt: after-live-state` on a committed clone | `injected-failure`; committed journal present; a later `installVersionedLive` recovered generation 1, WELCOME, `previousActivation` null |
| Install `failAt: pending-written` | startup code `pending-journal`; pending journal left in place |
| Set as Live `after-live-state` | HTTP 503, then boot recovered generation 2 and Test v2 `165b1a0c-5d7f-4ae9-813a-fdccd9a2fa93` |
| Publish `after-live-state` | HTTP 503, then boot recovered generation 2 and content hash `d13437f7d2a08488adb5661649ddc7c64660d21493b1ec493f83297e98a3de4f` |
| Restore Previous `after-live-state` | HTTP 503, then boot recovered generation 3 and WELCOME v2 `8705f283-c78a-4e8c-b420-2994ade60d74` |
| Set as Live `pending-written` | HTTP 503, boot `pending-journal`, pending directory left |
| Committed `plan.json` replaced with `{not-json` | boot `corrupt-journal`, the damaged file left in place |
| `live-state.json` deleted | boot `missing-live-state` |
| `script.txt` replaced with `drift\n` | boot `mirror-recovery-required`; the drifted bytes were left in place |
| Active version `script.txt` deleted | boot `hash-mismatch` |
| One referenced owned JPEG replaced with `not-an-image` | boot `corrupt-asset` |

Committed journals were recovered by the same installation or live-operation owner on the next start. Pending and corrupt journals, a missing or damaged Live State, a drifted mirror, a missing version, and a corrupt owned image refused startup and kept the evidence.

## P. Restart and persistence

**Verified.** The functional server was closed, including its coordinated library service. A new `createPrompterServer` on the same active root loaded:

| Check | Result |
| --- | --- |
| Live production | Test |
| Live version | Test v2 `165b1a0c-5d7f-4ae9-813a-fdccd9a2fa93` |
| Generation | 4 |
| Cue | `slideIndex` 0, the established in-memory restart position |
| Test history | 4 committed versions |
| Saved head | different from the live version |
| Migration id | unchanged; startup did not create another migration |

A second `createPrompterServer` in that same Node process was refused with `writer-active` (“This library already has a writer in this process.”). That check uses an in-process map.

**Limitation.** After the measured rehearsal, a separate probe started one fixture server on the disposable active root and a second OS process against the same root. The second process listened on `127.0.0.1`. The in-process refusal does not stop another process. M9C still needs a deployment that runs one writer. The probe did not touch the source repository.

## Q. Rehearsal rollback

**Verified.** Rehearsal listeners were stopped before the restore. The pre-migration backup was copied into a separate `restore` directory under the same temporary parent. Its manifest matched the original snapshot. WELCOME, Test, `script.txt`, the previous script, the index, and the shared images were the original hashes. No `migration.json` was present. `detectStorageMode` returned `legacy`. `createPrompterServer` without a fixture token, bound to `127.0.0.1`, served `script.txt` with hash `ab07d71d…e5d0`.

The source directory was not the restore target. Its post-rehearsal manifest still matched the initial manifest.

**Limitation.** Rollback replaced the whole rehearsal tree with the pre-migration snapshot. Edits made after migration on the active copy, including the extra production, the publish, and the later Live selection, were discarded by that restore. This rehearsal does not show a way to keep post-cutover edits while returning the show to Legacy. Deleting only `migration.json` was not used and would not be a rollback.

## R. Access-control limitations

**Verified, and unchanged.** M9B did not change route authorization.

These operations succeeded on the loopback rehearsal server without a staff token:

- `POST /script` publish, HTTP 200
- Restore Previous through `POST /script` with `X-Restore-Previous: 1`
- WebSocket `navigate`

`GET /api/library` without the token returned 401. The staff token gates library routes. It does not close `POST /script` or the WebSocket commands `navigate`, `goto`, and `reloadScript`. Hiding the controller UI does not stop a raw WebSocket `navigate`; the rehearsal sent one.

The server was bound to `127.0.0.1` only. No public interface, tunnel, firewall change, or deployment configuration was used. Loopback success is not a test of a production network boundary.

**Blocker.** A requirement for public Audience access before Security S2B keeps the M9C public-launch decision blocked until a verified gateway, or an equivalent tested filter, exists. Setting `PROMPTER_STAFF_TOKEN` does not by itself protect every write path.

## S. Defects, blockers, and fixes

No product defect was found that required a code change. The rehearsal runner lived outside the repository and was deleted with the temporary trees. No planner, staging, fixture-authorization, or startup rule was weakened.

Observed behavior that is easy to misread, and is existing behavior:

- Opening the show on a title image leaves `#lines-current .script-line` empty while the title image is visible. The next live cue renders the first line.
- Set as Live resets to the title image and can leave the previous cue text in `#lines-current` under the overlay. The rehearsal checked the title-image address.
- Restoring a shared-image v1 returns HTTP 400 `legacy-image`.
- `writer-active` is per process.

No M9B code fix was applied. The M9C blockers in section T remain.

## T. Outstanding requirements for M9C

M9C has not started. The following remain.

Implementation work in a later milestone, not done here:

- A persistent-root authorization that is not `authorizeVersionedFixture` and is not enabled by an HTTP parameter, query, or environment switch. `authorizeVersionedPersistentRoot` was not added.
- A single-writer process model. The current guard is in-process only, and a second OS process listened during the probe.
- Startup that can run Versioned Mode on an approved persistent root. Normal startup still refuses a committed marker without fixture authorization.
- Security S2B, on a separate branch and pull request, if application-level staff checks are the chosen protection. M9B did not implement it.

Decisions and work that belong to ADAPT or IT. None of these values were invented:

- An approved Node.js hosting environment. This repository has no `engines` field. The rehearsal machine was Node v24.18.0. The source’s deployment host is unknown.
- A persistent storage location and its backup disk.
- A deployment supervisor and restart policy that runs one writer.
- HTTPS and WebSocket connectivity, including the public or private address.
- A tested network or gateway boundary around `POST /script` and WebSocket `navigate`, `goto`, and `reloadScript`.
- A verified production backup procedure. The disposable rehearsal backup does not satisfy this.
- A named technical operator and a named rollback approver.
- A maintenance window.
- A final GO/NO-GO decision.
- A documented ADAPT operational acceptance checklist.

**Blocker.** Public operational launch stays blocked while those unauthenticated write paths are reachable. A private-network launch remains untested outside this loopback rehearsal.

Also carry forward:

- Recalculate source hashes at the maintenance window. Do not reuse this rehearsal’s migration id, version ids, asset ids, or v2 hash `acdcaaeadfe5225b3e6020d141965b0f2a2df945b7317621a8df4466ae992c62`.
- Expect the committed marker to be schema 2, the live production to be WELCOME v2, and `previousActivation` to be null.
- Confirm `script.txt` after installation matches the newly generated v2 hash.
- Treat rollback to Legacy as a full restore from the pre-migration backup. Post-cutover edits are outside that restore.

## U. Verdict

**PASS WITH LIMITATIONS.**

The acceptance checks that passed:

- Real ADAPT data was copied into an isolated rehearsal and the copy matched the source manifest.
- The source manifest was unchanged at the end, and the source still starts in Legacy Mode with no marker, Live State, productions tree, or journal.
- WELCOME was selected despite the stale Test `liveId`.
- Both productions migrated with intact v1 bytes and verified owned images.
- Schema 2 commit, generation-1 Live State, and the WELCOME v2 mirror were correct on the copy.
- The fixture server ran on loopback and the exercised Library, Editor, Controller, Actor, and Audience flows worked.
- Version History, preview, saved restore, crash recovery, restart, and rehearsal rollback behaved as required.
- Regression after the rehearsal: `node --test` 367 passed, 0 failed, 0 skipped; `npm run test:browser` 57 passed, 0 failed, 0 skipped. No rehearsal test was added to the repository. The pre-rehearsal baseline on `d254578` was the same pair of totals.

The limitations that keep this from an unqualified pass:

- M9C persistent-root authorization, hosting, storage, supervision, and a real production backup are not done.
- A second OS process can open the same library root.
- Public launch remains blocked until S2B or a tested gateway exists.
- The rehearsal backup was disposable and does not preserve post-migration edits on a Legacy rollback.
- Generated version and asset ids belong to this run only.
