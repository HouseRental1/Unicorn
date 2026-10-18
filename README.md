# Appliance Shop Till

A shop till for a home appliances store: sales with discounts and serial numbers, stock, installment plans, warranty claims, returns and refunds, staff PINs, day close and reports. It runs on Vercel, with the data in a Neon Postgres database connected through Vercel.

## How it is built

- `public/` is the app itself: one page (`index.html`), an offline app shell (`sw.js`), the install manifest and icons.
- `api/[action].js` holds the server functions the app calls: `status`, `setup`, `login`, `password`, `sync`, `doc`, `write` and `lock`.
- `api/_lib.js` connects to the database, creates the tables on first use, and handles passwords and sessions.
- `api/_seed.js` holds the sample records from the prototype. They are loaded only if you tick that box during setup.

The database tables (`shop_docs`, `shop_locks`, `shop_account`) are created automatically the first time the app runs.

## Settings on Vercel

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Added automatically when you connect a Neon database under **Storage**. |
| `SESSION_SECRET` | A long random string that signs device sessions. |
| `SETUP_CODE` | A one-time code needed to set the shop password the first time. |

## First run

1. Connect a Neon database to the project under **Storage**, then redeploy.
2. Open the site. Enter the setup code and choose the shop password.
3. In **Settings**, add yourself as the owner with a PIN, then add your staff.

Each till device signs in once with the shop password and stays signed in for 30 days. Changing the password signs every device out. Staff then pick their name and enter their PIN, so every sale, payment and refund is recorded under the person who did it.

## Printing

Open a receipt and choose **Print**. Receipts are laid out for 80 mm thermal printers. Pick the receipt printer in the print dialog.

## Running it locally

```
npm install
npm install --no-save @electric-sql/pglite@0.3.0
node test/server.js
```

Then open http://localhost:5055. The local server uses an in-memory Postgres, with the setup code `TILL-TEST-42`.

## Limits

- The app opens without a connection, but sales can't be saved until the connection is back.
- Reminders open WhatsApp with the message ready. Nothing is sent automatically.
