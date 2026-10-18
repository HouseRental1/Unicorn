# Unicorn Home Appliances

The shop till for Unicorn Home Appliances: sales with discounts and serial numbers, stock, installment plans, warranty claims, returns and refunds, staff PINs, day close and reports. It runs on Vercel, with the data in a Neon Postgres database connected through Vercel.

## How it is built

- `public/` is the app itself: one page (`index.html`), an offline app shell (`sw.js`), the install manifest and icons.
- `api/[action].js` holds the server functions the app calls: `status`, `setup`, `login`, `me`, `password`, `users`, `sync`, `doc`, `write` and `lock`.
- `api/_lib.js` connects to the database, creates the tables on first use, and handles passwords and sessions.

The database tables (`shop_docs`, `shop_locks`, `shop_users`) are created automatically the first time the app runs.

## Settings on Vercel

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Added automatically when you connect a Neon database under **Storage**. |
| `SESSION_SECRET` | A long random string that signs device sessions. |
| `SETUP_CODE` | A one-time code needed to create the owner login the first time. |
| `CRON_SECRET` | Lets only Vercel's evening job run the daily summary. |
| `RESEND_API_KEY` | Optional. Switches on the 8 pm summary email (free account at resend.com). |
| `SUMMARY_FROM` | Optional. Sender address once you verify your own domain with Resend. |

## First run

1. Connect a Neon database to the project under **Storage**, then redeploy.
2. Open the site. Enter the setup code and create the owner login: your name, a username and a password.
3. In **Settings**, add a login for each staff member with their own username, password, role and largest allowed discount.

## Logins

Everyone signs in with their own username and password, and every sale, payment and refund is recorded under their name. A device stays signed in for 30 days. Changing or resetting a password signs that person out everywhere, and an owner can turn a login off at any time.

| Role | Can |
| --- | --- |
| Sales | Sell, take installment payments, log warranty claims, close the day |
| Manager | All of the above, plus edit items, restock, give returns and see reports |
| Owner | Everything, including staff logins, shop settings and deleting items |

The server enforces the owner-only actions as well as the app. Passwords are stored as scrypt hashes.

## Daily summary

After closing the day, owners and managers see a summary they can send on WhatsApp in one tap: sales, money in, overdue customers, low stock and orders still to deliver. At 8 pm Ghana time a Vercel cron job (`api/daily-summary.js`) also emails it to the address saved in Settings, once `RESEND_API_KEY` is set.

## Backup and sign-in protection

Owners can download everything as one Excel file from Settings. After 5 wrong passwords a login is locked for 15 minutes (20 wrong tries locks the device). Owners see recent sign-ins and can unlock a login in Settings.

## Barcode scanning

The Scan buttons use the phone or laptop camera to read the barcode on the box (Code 128, Code 39, EAN, UPC, ITF, QR and others). The browser's own reader is used where it exists, otherwise the bundled ZXing library in `public/vendor/`.

## Printing

Open a receipt and choose **Print**. Receipts are laid out for 80 mm thermal printers. Pick the receipt printer in the print dialog.

## Running it locally

```
npm install
npm install --no-save @electric-sql/pglite@0.3.0
node test/server.js
```

Then open http://localhost:5055. The local server uses an in-memory Postgres, and the setup code is `TILL-TEST-42`.

## Limits

- The app opens without a connection, but sales can't be saved until the connection is back.
- Reminders open WhatsApp with the message ready. Nothing is sent automatically.
