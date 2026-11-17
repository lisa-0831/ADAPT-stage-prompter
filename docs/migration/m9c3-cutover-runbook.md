# M9C3 — Operator Runbook

Status: procedure for a future cutover. Do not run it during M9C2. Do not point it at the ADAPT checkout. Host names, paths, credentials, and approver names are filled in by ADAPT and IT. This file uses angle brackets for those blanks and does not assign them.

Commands below are implemented unless a step says **Gap**.

Read `docs/migration/m9a-readiness.md`, `docs/migration/m9b-rehearsal.md`, `docs/migration/m9c1-storage-safety.md`, and `docs/migration/m9c2-deployment-plan.md` before the window.

## GO / NO-GO before any irreversible step

Stop if any line is unanswered or failed.

1. The maintenance window is approved by the named ADAPT acceptance owner.
2. The technical operator and the rollback approver are named and present.
3. The host OS and local disk passed the flock child-process tests. NFS, SMB, and a second host are NO-GO.
4. One supervisor owns one Node process for `<persistent-storage-root>`.
5. Untrusted clients cannot open the HTTP port or complete a WebSocket upgrade. This was tested from outside the approved network, not only from the server itself.
6. The backend port is not reachable around the gateway.
7. HTTPS, if used, forwards WebSocket `Upgrade`.
8. A fresh backup exists, `verify` succeeded, and a restore into an empty directory matched the manifest.
9. The migration authorization file is outside git, mode `0600` or `0400`, and names that one root.
10. `preflight` shows the byte-matched live production, not the stored `liveId`.
11. `prepare` has printed a `planHash`, and `migration.json` is still absent.
12. The operator has the plan hash in the maintenance record before `commit`.

Commit, the first persistent start, and any rollback after the audience has used the new process each require their own GO from the list above.

## Cutover

1. **Approve the window.** Record the acceptance owner, the operator, the rollback approver, and the start time. NO-GO if any name is missing.

2. **Confirm the people.** The operator runs the commands. The rollback approver is the only person who can accept data loss after step 25.

3. **Confirm the host.** Record the OS, the filesystem type, and the result of the flock tests on that host. NO-GO if `lock-unsupported` or if the disk is shared.

4. **Confirm one writer.** The supervisor unit starts `node scripts/start-persistent.js` and no second unit uses the same root. `node server.js` is not the production command.

5. **Confirm the network.** From a client that is not on the approved network, `GET /script`, `POST /script`, and a WebSocket upgrade fail. Record the evidence. NO-GO if any succeed. This test is not done in M9C2.

6. **Confirm the backend port.** From outside the gateway, the Node listen port fails. A proxy that only blocks `POST` is NO-GO while WebSocket cue commands remain open.

7. **Confirm routing.** From an approved client, HTTP and the WebSocket upgrade reach the same process. Record the port and the bind address. The persistent launcher defaults to `127.0.0.1` and refuses `0.0.0.0`. A private bind is allowed only after step 5.

8. **Stop Legacy writers.** Stop every process that can write the Legacy tree, including a development `node server.js`. Confirm no Node process has the library open.

9. **Back up.** With the writers stopped:

   ```text
   node scripts/backup-storage.js create --source <persistent-storage-root> --dest <empty-backup-directory>
   node scripts/backup-storage.js verify --dest <empty-backup-directory>
   ```

   NO-GO if `verify` fails. This backup is the rollback copy. The M9B rehearsal copy is not a substitute.

10. **Restore-test.**

    ```text
    node scripts/backup-storage.js restore --dest <empty-backup-directory> --restore-to <empty-restore-directory>
    ```

    Compare the restore with the manifest. NO-GO on any mismatch. Leave the restore directory intact until the window closes.

11. **Confirm the source manifest.** The migration authorization's `sourceManifest` is the SHA-256 of every Legacy input in the persistent root: `script.txt`, the previous script and metadata, `data/library/index.json`, each `data/library/scripts/*.txt`, and each shared image under `images/`. No extra file is listed and none is missing. `expectedLiveProductionId` is the production whose saved script bytes equal `script.txt`. For the current ADAPT library that production is WELCOME, not the stored `liveId` of Test. Recompute the hashes in the window. Do not reuse M9B version or asset ids.

12. **Place the snapshot.** The persistent root is outside the application checkout. It already contains the verified Legacy snapshot from step 9's source. Do not migrate the git checkout.

13. **Preflight.**

    ```text
    node scripts/migrate-persistent.js preflight --config <migration-authorization>
    ```

    NO-GO unless `ok` is true, `liveProductionId` is WELCOME's id, Test is a separate production, and `migration.json` is absent. `live-id-drift` is expected and is not a reason to follow the stored `liveId`.

14. **Prepare and verify.**

    ```text
    node scripts/migrate-persistent.js prepare --config <migration-authorization>
    ```

    Record `planHash`, both production ids, the live production id, and the version ids. NO-GO unless `ready` is true and `migration.json` is still absent. `prepare` already runs the staging verification before it returns.

15. **Authorize the commit.** A second person reads the recorded `planHash` and the preflight identities. They approve that exact hash. There is no `--yes` switch. NO-GO if the hash is missing or was replaced by a later prepare.

16. **Commit.**

    ```text
    node scripts/migrate-persistent.js commit --config <migration-authorization> --plan <plan-hash>
    ```

    NO-GO if the exit status is not success. A `plan-mismatch` or `writer-locked` result means the marker was not written.

17. **Verify the marker.** `data/library/migration.json` is schema 2, `state` is `committed`, `previousActivation` is null, `productionId` is WELCOME's id, and `contentHash` matches the command output. Do not delete the marker to undo this step.

18. **Install Live State.** The first persistent start performs the initial installation. Do not call a second installer by hand. **Gap:** there is no separate install command. Installation happens inside `scripts/start-persistent.js` when the runtime authorization matches this marker.

19. **Write the runtime authorization.** Create it outside git after step 17. Purpose `adapt-persistent-runtime`. Copy `migrationId`, `productionId`, `versionId`, and `contentHash` from the marker. Do not include `mirrorInstalled` or `liveInstalled`. Mode `0600` or `0400`.

20. **Start the runtime.**

    ```text
    node scripts/start-persistent.js --config <runtime-authorization> --port <port> --bind <approved-address>
    ```

    The first listen installs Live State. WELCOME's migrated head is the active show. When WELCOME's script contains legacy `images/` lines, that head is v2. Test remains a separate production. `GET /script/previous` is 404 because `previousActivation` is null.

21. **Check the show.** From an approved client, Controller, Actor, and Audience show the same cue. Shared images load. A cue change on the Controller reaches Actor and Audience. WebSocket reconnects.

22. **Check library workflows.** With the staff token, Create, Save, Publish, Set as Live, Restore Previous, and version history behave as they do in the versioned tests. History preview does not change Live. Restore of a historical version creates a new saved head and does not by itself change the cue.

23. **Restart.** Stop the process. Start the same command. `GET /script` returns the same text. Live State is the committed file, not a new installation.

24. **Repeat the outside-network checks.** Untrusted clients still cannot reach `POST /script`, Restore Previous, or WebSocket `navigate`, `goto`, and `reloadScript`. NO-GO if they can. Staff token presence does not change this result.

25. **Acceptance.** The acceptance owner records that the show, the library, the restart, and the network checks passed.

26. **Leave the rollback copy.** Keep the step 9 backup and the step 10 restore until the approver releases them. Publish the supervisor command, the config file locations, and this runbook to the operators. Do not commit the authorization files or the staff token.

## Rollback

Before `commit`, run:

```text
node scripts/migrate-persistent.js abort --config <migration-authorization>
```

Abort refuses a committed marker. That is intentional.

After `commit`, stop the server. Restore the step 9 backup into the storage root only with the rollback approver's GO. Do not delete `migration.json`, `productions`, or journals to imitate Legacy mode. There is no reverse-migration command. **Gap:** the restore command writes into an empty directory. Copying that restore over a live root is an operator procedure, performed only while the writer is stopped, and only after the approver accepts it. It is not an automated flag.

After step 21, a restore discards every save, publish, and activation made since the backup. The rollback approver records that loss before the restore starts. Without that record, the decision is NO-GO.

## After the window

Security S2B is a separate branch and a separate PR. Do not start it from this cutover. Public Audience access stays blocked until that work, or until a tested gateway separates read-only show traffic from the commands in step 24.
