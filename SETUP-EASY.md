# Setup (no installs required)

Your Firebase project (InventroPro) config is already baked into index.html.
There's nothing to fill in.

## 1. Turn on Google Sign-In and Firestore (one-time, in Firebase console)
- Authentication → Sign-in method → enable Google
- Firestore Database → Create database → Production mode

## 2. Paste in the security rules (one-time, in Firebase console)
Firestore Database → Rules tab → delete what's there → paste the
contents of `firestore.rules` from this folder → click Publish.

## 3. Put these 6 files on GitHub
Create a public repo at github.com/new. On its page, click
"uploading an existing file" and drag in all six:
index.html, manifest.json, sw.js, favicon.svg, icon-192.png, icon-512.png

Commit directly to main.

## 4. Turn on Pages
Repo → Settings → Pages → Source → **Deploy from a branch** →
Branch: main, folder: **/ (root)** → Save.

Wait ~1 minute, then your app is live at:
`https://<your-github-username>.github.io/<your-repo-name>/`

## 5. Authorize that domain in Firebase
Authentication → Settings → Authorized domains → Add domain →
`<your-github-username>.github.io` (just that, no path, no https://)

## 6. Open the live link and test sign-in.

---

That's the whole deploy. No Node, no npm, no build step, no GitHub
Actions, no secrets to manage — every future change is: edit index.html
in VS Code → drag it back into the same GitHub repo page (it'll ask to
replace the existing file) → wait a minute → refresh the live site.
