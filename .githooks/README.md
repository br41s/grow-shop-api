# git hooks — asset-refs guard: not applicable

Sibling repos in this workspace (biglobster, grow-shop-landing, SocialAgenda,
FinView) ship a committed `.githooks/pre-commit` that fails a commit when it
would introduce a **new dangling reference** to a local static asset — an
`<img>`/`<link>`/`url_for(...)`/markdown image pointing at a file that does not
exist on disk. The Hermes managed git-guard (set via `core.hooksPath` per
clone) auto-discovers and chains to that hook.

**This repo intentionally has no such adapter.** `grow-shop-api` is a pure JSON
API: an Express service (`api.js`) with `/health` and `/api/submit-offer`
endpoints that send email via Resend. It serves **no static files** — no
`express.static`, no `res.sendFile`, no templates, no HTML/CSS/JS/image assets.
The only HTML is inline strings embedded in outbound emails, which reference
nothing on disk. There is therefore no referenced-asset surface for a refs
check to protect, and adding one would be dead weight.

The universal mass-deletion tripwire in the managed git-guard still applies to
this repo; only the repo-specific refs adapter is omitted.

If this service ever starts serving static assets (e.g. an admin page or
uploaded files), add a `.githooks/pre-commit` modelled on
`biglobster/scripts/validate-assets.sh` (the `refs` check) and a
`.githooks/asset-refs-baseline.txt`, like the sibling repos.
