# Inventro — remaining security setup

## Already applied in this package
- Firestore rules hardened for company isolation and role checks.
- Movement records have field-level update restrictions; ownership/audit identity cannot be rewritten.
- Movement creation now checks the authenticated employee role and allowed fields.
- Employee deletion cannot remove the company owner/admin account or the current admin itself.
- 3-day realtime movement optimization retained.
- No service-account/private-key/FCM/Gemini secret was added to the frontend.
- Rules test scaffold included in `tests/firestore.rules.test.js`.

## You must do these in Firebase/Google Cloud

### 1. Deploy the new Firestore rules
Firebase Console → Firestore Database → Rules → paste `firestore.rules` → Publish.
Or with Firebase CLI after linking the correct project:
`firebase deploy --only firestore:rules`

### 2. Run the rules tests
On a machine with Node.js + Java:
1. `npm install`
2. `npx firebase-tools login`
3. `npm run test:rules`

Do not run tests against production data. The included test suite uses the local emulator.

**Fixed 2026-09-18:** the test file must live at `tests/firestore.rules.test.js` for this script to find it, and the script now runs it through Mocha (`npx mocha tests/firestore.rules.test.js`) instead of plain `node`, since the file relies on Mocha's `describe`/`it` globals. If you're updating an existing checkout rather than replacing the whole project, make sure the test file is at that exact path — the previous location/script combination would fail immediately with `describe is not defined`, before ever reaching the emulator.

### 3. Enable Firebase App Check
Firebase Console → App Check → your Web app → register it.
Use reCAPTCHA Enterprise (or the provider currently offered for your web app), add the site key to the app, then verify that normal users pass App Check before enabling enforcement.
After monitoring for false positives, enable enforcement for **Cloud Firestore** and **Authentication** as appropriate.

This package does not hard-code an App Check site key because that value must come from your Firebase/Google Cloud project.

### 4. Enable billing monitoring / budget alerts
Google Cloud Console → Billing → Budgets & alerts.
Create a low-cost monthly budget and email alerts for forecasted/current spend.
A budget alert does not automatically stop Firebase usage.

### 5. Review Google/Firebase API restrictions
Firebase web API keys are not passwords. Keep them restricted to Firebase APIs and your authorized web domains where applicable. Never put service-account JSON, private keys, FCM server keys, or other server credentials in this repository.

### 6. GitHub history check
Search the entire repository and Git history for:
- `-----BEGIN PRIVATE KEY-----`
- `serviceAccount`
- `client_secret`
- `FCM_SERVER_KEY`
- `AIza` keys belonging to non-Firebase APIs
- `.json` service-account files

If a real secret was ever committed, rotate/revoke it; deleting the file in a later commit is not enough.

### 7. Firebase Console Rules Playground smoke tests
Before/after publishing, test at least:
- unauthenticated → company/item read = DENIED
- Company A member → Company B document = DENIED
- Inventory Manager → own movement edit = ALLOWED only for allowed fields
- Inventory Manager → change `byUid`, `byEmail`, `createdAt`, `unit` = DENIED
- Inventory Manager → edit another user's movement = DENIED
- Stock Requester → direct movement create = DENIED
- Admin → initial `receive` movement = ALLOWED
- fake `byRole:'admin'` from Inventory Manager = DENIED

Firebase notes that Rules are not filters: queries must themselves satisfy the rule constraints.
