# CarEMI — i20 Active payment approval tracker

Installable shared tracker for the i20 Active. Friends submit an EMI amount with a receipt screenshot. Anunay reviews it; only approved payments reduce the balance. The Cloudflare D1 database keeps the plan, payment submissions, receipts, push subscriptions, and append-only audit events.

## Current plan seeded in D1

- Agreed car price: ₹2,75,000
- Down payment: ₹70,000 on 10 Aug 2026
- Monthly installment: ₹15,000
- Approved EMIs: ₹15,000 on 3 Sep 2026 and ₹15,000 on 2 Nov 2026
- Balance: ₹1,75,000, with 12 installments left

## Cloudflare setup

1. Install Wrangler and sign in to the Cloudflare account:

   ```sh
   npx wrangler login
   ```

2. Create the separate D1 database and copy its ID into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create i20-installments
   ```

3. Apply the schema and existing approved payment history:

   ```sh
   npx wrangler d1 migrations apply i20-installments --remote
   ```

4. Add the private secrets `BOOTSTRAP_TOKEN`, `ACCESS_CODE_PEPPER`, and `VAPID_PRIVATE_JWK` with `wrangler secret put`. Put the matching `VAPID_PUBLIC_KEY` in `wrangler.jsonc`.

5. Deploy the API Worker and copy its `workers.dev` URL into the `API_BASE` constant in `index.html`:

   ```sh
   npx wrangler deploy
   ```

6. Push the project to GitHub Pages. The Worker accepts requests from `https://anunay117.github.io` and stores data in D1.

## Access and notifications

- The owner signs in with the initial `BOOTSTRAP_TOKEN`, then chooses **Access codes** to set both custom codes. After that, bootstrap recovery is disabled.
- Custom owner and friend codes are reusable and do not expire. They are stored as HMAC-protected hashes in D1; the Worker secret `ACCESS_CODE_PEPPER` protects those hashes. Keep the codes private. Anyone with the friend code can sign in as the friend.
- Login sessions expire after 120 days; the same permanent access code can be used to sign in again.
- Both phones must open the site, install it to the Home Screen, and tap **Enable notifications**. Push delivery requires the browser's notification permission.
- Each new payment stores a resized screenshot (up to 1.2 MB), amount, payment date, submitter, and status. Pending payments reserve available balance but do not count as paid.
- The app does not offer a delete action. Payment details are immutable after submission; decisions and plan changes are written to append-only audit events. Cloudflare account owners can still change database resources directly.

## Local files

- `index.html` — PWA UI and authenticated client
- `sw.js` and `manifest.webmanifest` — installation, offline shell, and push display
- `worker/index.js` — Cloudflare Worker API and Web Push sender
- `migrations/0001_initial.sql` and `0002_custom_access_codes.sql` — D1 schema, existing payment history, and permanent code hashes
