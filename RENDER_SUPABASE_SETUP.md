# Render + Supabase setup

This project keeps its existing Site A and Site B JSON-shaped data model, but stores each service state in Supabase PostgreSQL when `DATABASE_URL` is configured. The namespaces are separate:

- `site_a`: users, sessions, cards, deposits, purchases, codes, withdrawals, ledgers, receipts, admin records, and KYC metadata.
- `site_b`: Paystack payment-service transactions and webhook events.
- `bundle`: separate data-bundle orders.

The payment architecture is unchanged. Site B remains the only service that receives `PAYSTACK_SECRET_KEY`, performs Paystack verification, handles Paystack webhooks, and sends signed callbacks to Site A.

## 1. Supabase

1. Open the Supabase project’s **Connect** panel.
2. Copy the PostgreSQL **Transaction Pooler** connection string. Use the pooler host and port `6543`; do not put this value in source code or the browser.
3. Keep the password URL-encoded if it contains characters such as `@`, `#`, `/`, or `:`.
4. The application applies `DATABASE_SSL=true` by default. The connection uses a small pool suitable for Render.

## 2. Import the existing local records once

Make a backup of the current files before importing. The importer never deletes or overwrites a conflicting database namespace.

From the project root, set the Supabase URL only in your shell:

```bash
export DATABASE_URL='your-supabase-transaction-pooler-url'
export DATABASE_SSL=true
export DATABASE_POOL_MAX=4
```

Run the repeatable schema migration:

```bash
npm install
npm run db:migrate
```

Import Site A state and KYC binaries:

```bash
node scripts/migrate-json-to-postgres.js \
  --source ./data/phantom-cards.json \
  --namespace site_a \
  --blobs ./data/kyc-documents
```

Import Site B state and bundle orders:

```bash
node scripts/migrate-json-to-postgres.js \
  --source ./payment-service/data/payment-service.json \
  --namespace site_b

node scripts/migrate-json-to-postgres.js \
  --source ./payment-service/data/data-bundles.json \
  --namespace bundle
```

Verify the imported namespaces and blob totals:

```bash
npm run db:check
```

Keep the original JSON and KYC directories as a rollback backup. Do not run `npm run reset` with a database URL; database reset is intentionally disabled.

If the importer reports a duplicate, missing relationship, missing KYC file, or conflicting namespace, stop and resolve that report. It does not silently merge financial records.

## 3. Render Site A

Create a Render Web Service from the repository root:

- Build command: `npm install`
- Start command: `npm start`

Add these environment variables in Render. Enter secrets through Render’s environment-variable UI; do not edit source files.

```text
APP_BASE_URL=https://<site-a-render-host>
SITE_B_BASE_URL=https://<site-b-render-host>
PAYSTACK_CURRENCY=GHS
SITE_A_TO_SITE_B_SECRET=<long-random-shared-secret>
SITE_B_TO_SITE_A_SECRET=<different-long-random-shared-secret>
PAYMENT_SESSION_MINUTES=15
ADMIN_EMAIL=<admin-email>
ADMIN_PASSWORD_HASH=<scrypt-hash>
ADMIN_APPROVAL_TOKEN=<long-random-token>
DATABASE_URL=<supabase-transaction-pooler-url>
DATABASE_SSL=true
DATABASE_POOL_MAX=4
DATABASE_NAMESPACE=site_a
```

Render supplies `PORT` automatically. Do not set `PAYSTACK_SECRET_KEY` on Site A. Do not set `PHANTOM_DATA_FILE` or `KYC_DOCUMENTS_DIR` for the deployed database-backed service.

## 4. Render Site B

Create a second Render Web Service from the same repository. The service can use `payment-service` as its root directory, because that directory already resolves the shared root `storage.js` and `payment-config.js` files.

- Build command: `npm install`
- Start command: `npm start`

Add:

```text
SITE_A_BASE_URL=https://<site-a-render-host>
SITE_B_BASE_URL=https://<site-b-render-host>
SITE_A_TO_SITE_B_SECRET=<exact-site-a-value>
SITE_B_TO_SITE_A_SECRET=<exact-site-a-value>
PAYSTACK_SECRET_KEY=<Paystack-test-secret-for-testing>
PAYSTACK_API_BASE_URL=https://api.paystack.co
PAYSTACK_CURRENCY=GHS
DATA_BUNDLE_PAYMENT_EMAIL=<approved-payment-email-if-bundle-checkout-is-used>
DATA_BUNDLE_ADMIN_TOKEN=<long-random-private-token>
DATABASE_URL=<same-supabase-transaction-pooler-url>
DATABASE_SSL=true
DATABASE_POOL_MAX=4
DATABASE_NAMESPACE=site_b
DATABASE_BUNDLE_NAMESPACE=bundle
```

Render supplies Site B’s `PORT`. Do not expose `PAYSTACK_SECRET_KEY` to Site A or any frontend code.

Configure the Paystack webhook as:

```text
https://<site-b-render-host>/api/v1/webhooks/paystack
```

Use HTTPS URLs in production. Site A will reject an invalid or non-HTTPS Site B handoff URL in production.

## 5. Verify the deployment

Check both health endpoints:

```bash
curl -sS https://<site-a-render-host>/api/health
curl -sS https://<site-b-render-host>/api/health
```

Create a test account through the existing UI, sign out, sign back in, and confirm the account still appears after a Render restart or redeploy. The account, session data, balances, and records should remain in Supabase; no local disk is required.

For payment testing, use only Paystack test mode and a Paystack test key/test payment method. Test a small wallet top-up and verify that Site B’s callback is what changes the Site A wallet balance. Do not test with a live key, real card, real withdrawal, refund, or customer funds during deployment verification.

## 6. Back up and restore

Back up the database from a machine with PostgreSQL client tools installed:

```bash
pg_dump --format=custom --file=phantom-supabase-$(date +%Y%m%d-%H%M%S).dump "$DATABASE_URL"
```

Restore into a new Supabase project or a separate empty database first:

```bash
pg_restore --no-owner --dbname="$RESTORE_DATABASE_URL" phantom-supabase-YYYYMMDD-HHMMSS.dump
```

Do not use `pg_restore --clean` against the live database. Keep the source JSON/KYC backup until the restored service has been verified. The application’s state rows contain the original identifiers and relationships; KYC binaries are stored in `app_blobs` and are included in the database dump.

## 7. Important failure behavior

If `DATABASE_URL` is set but a required namespace was not imported, the service fails closed with a startup/request error rather than creating fabricated users, balances, or payment records. If a concurrent update is detected, the stale operation is rejected; retrying the existing idempotent request is safe and cannot create a second credit, purchase, reward, or withdrawal.
