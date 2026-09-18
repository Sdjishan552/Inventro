# Inventro Security Hardening Report

Date: 2026-09-18

## Scope

This hardening pass was applied to the Inventro PWA files available in the working project snapshot. The existing architecture and Firestore schema were preserved.

## Changes applied

1. **Firestore access is no longer broadly open to signed-in users.** Company, employee, department, inventory, movement, request, event, notification, and membership access is now role/company scoped.
2. **Company isolation:** active membership/employee records are required before accessing company data. Join-code lookup is restricted so an authenticated user cannot simply enumerate every company code.
3. **Role enforcement in Firestore Rules:** Admin, Inventory Manager, request roles, and ordinary members have separate server-side permissions.
4. **Membership protection:** a user can no longer rewrite their own company ID, role, or email through the membership document. Only the personal PIN/biometric bookkeeping fields are self-writable after membership creation.
5. **Admin escalation protection:** employee creation cannot create another Admin; employee role/status updates are restricted to an existing Admin and to allowed non-admin roles.
6. **Historical transaction protection:** movement creation, edits, and revisions are restricted by authenticated UID and role. Revision records cannot be updated/deleted after creation.
7. **Request protection:** request reads are limited to the company queue for Admin/Inventory Manager and to the request owner for other roles. Request status changes are role constrained.
8. **Notification privacy:** notifications are readable only by their intended recipient; recipients can only update `read`/`readAt`.
9. **PWA client optimization/security:** non-admin clients no longer maintain a realtime listener for the entire employee directory; request listeners are filtered to the user's own requests where appropriate.
10. **Realtime movement window:** the live movement window is set to 3 days, while older history remains on-demand. This preserves data rather than deleting it.
11. **Historical movement listener optimization:** movement listeners are maintained only for items whose current item record has been updated within the live 3-day window; the realtime item listener remains the source of truth for current stock.
12. **Cache version:** application/service-worker cache versions were bumped to v90 so browsers do not continue serving the older client bundle.

## Frontend secret audit

The Firebase Web configuration is present in `app.js`. The Firebase Web `apiKey` is intentionally public client configuration and is not treated as a database password. Firebase documents that Firebase-provisioned API keys identify the project/app; authorization comes from Authentication, Security Rules, IAM, and App Check.

No service-account private key, Admin SDK credential, Gemini API key, FCM server key, or private-key material was found in the supplied application files by the static scan.

## Important remaining configuration item

**Firebase App Check was not automatically enabled in this code package.** Enabling it requires configuration in the Firebase/Google console (including the appropriate web provider/site key). It should be configured and monitored before production enforcement is enabled.

## Testing performed

- `app.js` JavaScript syntax check: **PASS** using Node.js `--check`.
- Static scan for open Firestore rules (`allow ... if true` / broad `request.auth != null`): **no matches** in the hardened rules.
- Static scan for common private-key/service-account/Gemini/FCM secret patterns: **no matches** other than the expected Firebase Web API key.
- Firestore Security Rules were reviewed against the observed application paths and operations.

## Tests NOT performed in this environment

The Firebase Local Emulator Suite was not available/running in this environment, and the production Firebase project was not accessed or modified. Therefore, the following have **not** been marked as PASS:

- unauthenticated Firestore access tests against a live/emulated database
- Company A -> Company B attack tests
- Admin self-promotion attack tests
- direct unauthorized Firestore write tests
- full Rules unit-test suite
- production App Check enforcement test

These should be run with the Firebase Local Emulator Suite before publishing the new rules. Firebase recommends the Local Emulator Suite for automated Security Rules tests and provides `assertSucceeds`/`assertFails` testing support.

## Production deployment caution

Do not publish `firestore.rules` blindly over a production project without first testing it against a copy/emulator of the current data model. Security Rules are authorization code and can intentionally cause permission-denied responses if an application query does not match the rule constraints.

The hardened client was adjusted for the main query boundaries, especially employee and request listeners.

## Cost impact

The hardening itself has no separate Firestore security-rule fee. The main cost consideration is whether a rule uses additional document lookups (`get`/`exists`) and whether the client creates extra reads. This version deliberately avoids broad employee/request listeners for non-privileged roles and keeps the recent movement window at 3 days.

## Recommended final production checklist

- [ ] Test `firestore.rules` with Firebase Local Emulator Suite.
- [ ] Test unauthenticated access -> DENY.
- [ ] Test Company A user reading Company B -> DENY.
- [ ] Test user changing own role -> DENY.
- [ ] Test user changing own companyId -> DENY.
- [ ] Test Inventory Manager performing Admin-only employee/item operations -> DENY.
- [ ] Test requester reading another user's request -> DENY.
- [ ] Test requester reading another user's notification -> DENY.
- [ ] Test unauthorized movement edit/delete -> DENY.
- [ ] Test revision update/delete -> DENY.
- [ ] Configure and test Firebase App Check.
- [ ] Configure Firebase/Google Cloud budget and usage alerts.
- [ ] Keep any service-account/private credentials out of the frontend/repository.
- [ ] Publish Rules only after emulator tests pass.

## Important security principle

`app.js` should be treated as public. Security does not depend on hiding or obfuscating the frontend. The important boundary is that Firebase Authentication and Firestore Security Rules reject unauthorized database requests even if an attacker modifies the browser code.

## Recheck update — 2026-09-18

Applied after the first security recheck:
- Hardened movement `update` rules with field-level `affectedKeys().hasOnly(...)` restrictions.
- Movement ownership, original author email/UID, unit, item name and original creation timestamp are protected from mutation.
- Edit/delete audit fields are required to match the authenticated user and the edit counter must advance correctly.
- Movement creation now validates the authenticated employee role and restricts allowed fields.
- Inventory Manager / Stock Requester cannot spoof `byRole` during movement creation.
- Employee deletion cannot remove the company owner/admin account or the current admin account.
- Added Firebase Local Emulator rules-test scaffold under `tests/` plus `firebase.json` and `package.json`.
- Added `SECURITY-SETUP.md` listing the remaining console/GitHub actions.

Not claimed as completed in this package:
- App Check registration/enforcement (requires a project-specific App Check site key and Firebase Console action).
- Production Rules deployment.
- Local Emulator execution of the included test suite; the environment used to prepare this package did not have Firebase CLI/emulator installed and network installation timed out.
- Billing budget/alert configuration.
- GitHub historical-secret verification.

## Second verification pass — 2026-09-18

This pass checked the delivered package file-by-file against the claims made above instead of assuming they held, and cross-checked every rule against the actual `app.js` write call sites. Two real rule gaps were found and fixed; the test harness itself was also found to be non-functional and was repaired. Everything else checked out.

### Findings

1. **[Medium] `firestore.rules` — movement `byRole` was not protected from mutation on update.**
   - Location: `items/{itemId}/movements/{movementId}` `update` rule.
   - The rule's allowed-field list (`affectedKeys().hasOnly([...])`) included `byRole`, but unlike `byUid`, `byEmail`, `unit`, `itemName`, and `createdAt`, nothing required the new value to match the existing one. An Inventory Manager or Stock Requester editing their own movement could rewrite `byRole` to any value, including `'admin'`.
   - Actual authorization always comes from the caller's live `employees/{email}` document, not from `byRole` on a movement, so this could not itself be used to gain admin rights. But it directly contradicts this report's own claim that "movement ownership, original author email/UID, unit, item name and original creation timestamp are protected from mutation" — `byRole` is part of that same audit identity — and it let a user corrupt the historical record of who performed a transaction in what role.
   - Fix: `byRole` is now locked to its original value on every update. The only exception is a one-time backfill for legacy movements that predate the `byRole` field, and even then the new value must equal the editor's own current role from their employee record, never an arbitrary one.
   - New regression test added: `blocks rewriting byRole on an existing movement (audit-identity spoofing)`.

2. **[Low] `firestore.rules` — item audit-attribution fields were not checked against the actual caller.**
   - Location: `items/{itemId}` `update` rule, Inventory Manager branch.
   - `updatedByEmail`, `procurementOrderSentByUid/Email`, and `procurementFulfilledByUid/Email` were all writable, but only `updatedBy` was checked against `myUid()`. Nothing stopped an Inventory Manager from writing someone else's email or UID into these attribution fields.
   - Verified against `app.js`: every call site that sets these fields already always sets them to the acting user's own `uid`/`email`, so this fix changes no legitimate app behavior.
   - Fix: each of these fields, when present in an update, must now equal the caller's own `myUid()`/`myEmail()`.

3. **[Functional defect, not a vulnerability] The delivered Rules-test harness could not run.**
   - The test file was delivered as `firestore_rules_test.js` at the project root, while `package.json`'s `test:rules` script looked for `tests/firestore.rules.test.js` — a different name and location.
   - Independently of that, the script ran the file with plain `node`, but the test file uses Mocha's global `describe`/`it`/`before`/`after` (Mocha is even listed in `devDependencies` but was never invoked). Run either as originally delivered, or by itself with `node`, it fails immediately with `ReferenceError: describe is not defined` — before it even reaches the emulator.
   - This was confirmed by actually running both the original and corrected versions in a sandboxed Node 22 + Java 21 environment. The original crashes immediately on `node tests/firestore.rules.test.js`. The corrected version runs cleanly under Mocha and gets exactly as far as needing a live Firestore emulator, which this sandbox could not download (`storage.googleapis.com` is outside its network allowlist) — the same Local Emulator Suite limitation already disclosed above. So the individual `assertSucceeds`/`assertFails` assertions still could not be executed end-to-end here, but the harness itself now runs correctly and will complete on a machine with normal internet access.
   - Fix: moved the test file to `tests/firestore.rules.test.js` and changed the script to `npx mocha tests/firestore.rules.test.js --timeout 20000`.

### Checked and found already correct
- `app.js`'s Firebase config is the standard public client config; a full pattern scan (service-account/private-key/Gemini/FCM/password/secret patterns) found nothing beyond the expected public `apiKey`.
- Company isolation, admin-escalation protection, employee-deletion protection (owner/admin can't be removed), request/notification scoping, and the 3-day realtime movement window (`MOVEMENT_LIVE_DAYS = 3` in `app.js`) all match this report's claims on direct inspection of the rule text and the corresponding `app.js` code.
- The non-admin employee-directory listener genuinely subscribes to only the caller's own employee document; only `admin` gets the full-collection listener, matching the rules' own `read` condition.
- The 8 pre-existing rule tests were traced by hand against the current rule text (not executed, for the reason above) and each would pass.
- `sw.js`, `manifest.json`, `index.html`, `firebase.json`: no issues found.
- `localStorage`/`sessionStorage` usage in `app.js` holds only version markers, timestamps, notification IDs, and a WebAuthn credential ID — no company, financial, or personal data.
- Sample-checked `innerHTML` call sites in `app.js` (43 total): user-controlled strings (item names, notes, emails, statuses) are consistently passed through `escapeHtml()`. This was a sample check, not exhaustive line-by-line coverage.

### Remaining observation (not changed — a product decision, not a drive-by fix)
- The personal unlock PIN is hashed client-side with a single unsalted SHA-256 pass (`hashPin` in `app.js`) before being stored in `memberships/{uid}.securityPinHash`. For a 4–8 digit PIN this is a weak KDF if that field were ever exposed — though it's a secondary, local unlock gate behind Google Sign-In, not the primary authentication boundary, and Rules already restrict that field to the owning user. Moving to a salted, iterated hash (e.g. PBKDF2) would invalidate every existing user's stored PIN and needs a migration plan, so it wasn't changed here.

### Files changed in this pass
`firestore.rules`, `package.json`, and the test file (relocated to `tests/firestore.rules.test.js` with one new test added). `app.js`, `style.css`, `index.html`, `manifest.json`, `firebase.json`, `sw.js` were reviewed and left unchanged. `SECURITY-SHA256.txt` was regenerated to cover the current, complete file set (it previously omitted the test file entirely).
