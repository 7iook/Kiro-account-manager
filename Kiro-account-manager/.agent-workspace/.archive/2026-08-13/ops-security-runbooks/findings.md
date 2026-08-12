# Ops / security runbooks findings

Date: 2026-08-13  
Scope: documentation only; no `src/**`, `docs/deployment/**` or `deploy/**` edits; no commit.

## Documents created

1. `docs/operations/data-migration.md`
   - One-time, copy-only migration of `kiro-accounts.json`.
   - Runtime-based desktop source discovery on Windows/macOS/Linux without inventing an app-name subdirectory.
   - Source/target SHA-256, offline decryption/count check, target owner/mode, isolated startup verification and deterministic backout.
   - Operator-visible absent/undecryptable/newer-version/unwritable outcomes and exit codes.

2. `docs/operations/key-handling.md`
   - Separates the fixed main-store obfuscation key, `KIRO_BACKUP_KEY`, and panel `adminKey`.
   - Documents log-free `KIRO_ADMIN_KEY` first boot, one-time stdout exposure, authenticated/CSRF-protected rotation, env-managed rotation refusal, 0600 enforcement and filesystem-only loss recovery.

3. `docs/operations/backup-restore-upgrade.md`
   - Cold whole-data-directory backup, SHA verification, isolated decrypt verification and required real restore drill.
   - Restore, upgrade and binary+data rollback sequence.
   - Journald/container rotation ownership and the interaction between retained logs and bootstrap adminKey exposure.
   - Explicitly does not promise automatic restoration from the application `.backup.enc`.

4. `docs/security/network-exposure.md`
   - Caddy is the canonical TLS front because automatic issuance/renewal reduces the unsafe pre-certificate window.
   - nginx translation requirements, loopback binds, forwarded-header non-trust, firewall, public/private endpoint boundary.
   - Anonymous `/panel/readyz` versus sensitive anonymous proxy `/health`.

## Main code anchors

### Data location, format and failure semantics

- Desktop uses `app.getPath('userData')`, then `electron-store` named `kiro-accounts`: `src/main/index.ts:1038-1075`.
- Server uses explicit `dataDir`, `configName=kiro-accounts`, same encryption key: `src/main/persistence/accountStore.conf.ts:55-103`.
- Filename and fixed compatibility key: `src/main/persistence/accountStorePort.ts:72-82,128-130`.
- Main encryption is deliberately obfuscation/compatibility, not security: `src/main/persistence/accountStorePort.ts:60-66`.
- Four file states and decode behavior: `src/main/persistence/accountStorePort.ts:117-126,142-236`.
- Version refusal: `src/main/persistence/accountStorePort.ts:255-279`.
- Directory/file write gate: `src/main/persistence/accountStorePort.ts:281-336`.
- Operator messages and exit mapping: `src/main/server/config.ts:24-38,200-257`.
- Startup prints classified failure and exits with that code: `src/main/server/entry.ts:291-301`.

### Key material

- `KIRO_ADMIN_KEY`, `adminKey` path and 0600 target: `src/main/server/adminKeyStore.ts:69-85`.
- Key strength and source semantics: `src/main/server/adminKeyStore.ts:16-26,101-135`.
- Env/file conflict and env-managed mode: `src/main/server/adminKeyStore.ts:354-380`.
- Generate/write/verify/print transaction: `src/main/server/adminKeyStore.ts:397-415`.
- Log-exposure warning and recovery text: `src/main/server/adminKeyStore.ts:788-843`.
- Env-managed runtime rotation refusal: `src/main/server/adminKeyStore.ts:853-907`.
- Auth session+CSRF gate: `src/main/webPanel/auth.ts:176-199`.
- Rotation response/session invalidation/no-store: `src/main/webPanel/server.ts:345-380`.
- Rotation behavior tests: `test/main/webPanel/adminKeyRotation.server.test.ts:59-120`.
- Server backup key and plaintext opt-in: `src/main/secureBackupCipher.aesGcm.ts:37-47,69-104`.
- Desktop safeStorage versus server AES-GCM: `src/main/secureBackupCipher.safeStorage.ts:1-15`; `src/main/secureBackupCipher.aesGcm.ts:1-33,128-151`.

### Backup, shutdown and logs

- Backup carriers, atomic write and read-failure semantics: `src/main/secureBackup.ts:17-44,52-59,103-191`.
- Server backup write wiring: `src/main/server/assembly.ts:507-532`.
- Ordered shutdown/drain/flush: `src/main/server/assembly.ts:399-418`.
- Signal and forced second-signal behavior: `src/main/server/entry.ts:226-270`.
- stdout/stderr to journal: `deploy/systemd/kiro-account-manager.service:35-37`.
- Console truncation configuration: `src/main/server/config.ts:73-80`; `src/main/proxy/logger.ts:54-84`.
- File logger disabled by default and requires explicit directory: `src/main/proxy/logger.ts:47-52,96-129`.
- Internal file rotation implementation (not enabled by server assembly): `src/main/proxy/logger.ts:159-191`.

### Network and exposure

- TLS deliberately external: `src/main/server/entry.ts:42-50`.
- Loopback defaults: `src/main/server/assembly.ts:268-297`.
- Panel env overrides: `src/main/server/config.ts:65-79,149-153`.
- Panel uses socket peer IP: `src/main/webPanel/server.ts:258-270`.
- Proxy explicitly ignores X-Forwarded-For: `src/main/proxy/proxyServer.ts:2246-2249`.
- Anonymous readiness returns only ready/not_ready: `src/main/webPanel/server.ts:289-298`.
- Proxy `/health` and `/` bypass API key: `src/main/proxy/proxyServer.ts:2408-2420,2464-2465`.
- Proxy health leaks account and traffic statistics: `src/main/proxy/proxyServer.ts:2727-2744`.
- systemd liveness/readiness distinction: `deploy/systemd/kiro-account-manager.service:19-28`.

## Unverified items requiring real Linux validation

1. POSIX owner/mode, ACL, rename and write checks: authored on Windows; validate on ext4 plus the actual production filesystem, especially NFS/CIFS/bind mounts.
2. systemd startup, stop/drain timing, classified exit statuses and journal retention: not executed on a Linux host in this task.
3. Caddy certificate issuance, config syntax in the installed Caddy version, streaming behavior and external path denial: no DNS/public Linux host was available.
4. UFW/nftables, cloud security groups, IPv6 and container port publication: validate from external IPv4, external IPv6, same VPC and localhost.
5. Cold tar preservation of ACL/xattrs/numeric owners and actual restore drill: no Linux backup target was available.
6. Release symlink layout and rollback commands: now aligned with `docs/deployment/linux-systemd.md:206-210`, but not executed on Linux.
7. Full fresh-Linux restore/start/restart with real but redacted accounts and the deployed unit: must be run and recorded before declaring the backup restorable.

## Code defects / gaps observed but not fixed

1. `proxyLogStore` is not initialized by server assembly. Every proxy log still calls `proxyLogStore.add()`, which schedules a write while `storePath` remains empty; this can produce repeated write failures and no reliable `proxy-logs.json`.
   - Evidence: `src/main/proxy/logger.ts:325-342,370-450`.
   - Desktop-only initialization: `src/main/index.ts:466-470`.
   - Documentation treats journald/container stdout as the only reliable server log sink.

2. TLS-fronted panel sessions cannot mark cookies `Secure`. Server assembly constructs `new PanelAuth(adminKeyStore)` without `isHttps`; default is false, so the cookie serializer omits `Secure` even when Caddy terminates HTTPS.
   - Evidence: `src/main/server/assembly.ts:371-383`; `src/main/webPanel/auth.ts:61-85`; `src/main/webPanel/cookie.ts:26-44`.
   - Runbook mitigates with strict loopback binding and firewall, but this remains a hardening defect.

3. Forwarded client IP is intentionally unsupported, so all Caddy-originated clients collapse to `127.0.0.1` for login throttling and IP policy. A remote attacker's failed logins can therefore consume the same throttle bucket as a legitimate administrator.
   - Evidence: `src/main/webPanel/server.ts:258-268`; `src/main/proxy/proxyServer.ts:2246-2249`.
   - This is safer than trusting spoofable headers but needs a future explicit trusted-proxy design or front-layer rate limiting.

4. The server write path can create `.backup.enc`, but no verified headless restore orchestration was found in server assembly. The runbook does not claim that replacing the `.enc` and restarting restores data.
   - Write evidence: `src/main/server/assembly.ts:507-532`.
   - Backup reader exists in the shared kernel: `src/main/secureBackup.ts:149-191`; desktop consumes it at `src/main/index.ts:1095-1129`.

5. The current sibling-owned `deploy/systemd/server.env.example` documents `KIRO_ADMIN_KEY` but not `KIRO_BACKUP_KEY`. First account-save backup can therefore fail lazily despite service startup succeeding.
   - Environment example: `deploy/systemd/server.env.example:1-18`.
   - Lazy cipher construction/failure: `src/main/server/assembly.ts:507-532`; `src/main/secureBackupCipher.aesGcm.ts:69-104`.
   - Not edited because `deploy/**` is outside this agent's ownership.

6. The sibling-owned deployment guide cross-references migration/TLS/firewall files under `docs/deployment/`, but the ownership contract for this task places them under `docs/operations/` and `docs/security/`.
   - Evidence: `docs/deployment/linux-systemd.md:115-120,212-221`.
   - The runbooks created here use the required directories; the deployment owner must update those links rather than duplicating these documents.

## Deliberately left out

- No package installation, Node setup, release packaging, service installation or systemd enablement steps: sibling owns `docs/deployment/` and `deploy/`; duplicating them would create two install contracts.
- No Docker Compose/image example: current official sibling deliverable is systemd; an unverified container story would be a second deployment contract.
- No nginx config block: Caddy is canonical by requirement. nginx users get a precise translation checklist so the security contract remains single-source.
- No unauthenticated adminKey reset endpoint: filesystem access is the recovery authority; an unauthenticated auth reset is an authentication bypass.
- No copy/sync back to desktop: approved model is separate copies after one-time migration.
- No desktop safeStorage backup migration: its encryption envelope is machine/keyring bound and intentionally incompatible with the server AES-GCM envelope.
- No edits to `src/**`, including the defects above and the sibling-owned single-instance lock.
- No public proxy `/health`: it leaks account and traffic statistics; Caddy blocks both `/health` and `/`.

## Verification performed in this task

- Re-read all cited source sections from the current working tree.
- Read the concurrently created systemd unit and env example only to align service name, user, paths and journal behavior; did not modify them.
- Re-read all four generated documents after writing.
- Confirmed the exact current `/health` response implementation at `src/main/proxy/proxyServer.ts:2727-2744`.
- `npx prettier --check` passed for all four runbooks and this findings file.
- No Linux commands, Caddy validation, service startup, migration, restore or destructive operation was run.
