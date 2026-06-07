# BelNavo tech

BelNavo tech is a service booking website for design, web, branding, motion, and e-commerce work.

It includes:
- user signup and login
- booking and payment tracking
- card payments through Flutterwave
- admin dashboard
- user management
- audit logs
- email notifications
- legal pages and backup support

## Tech Stack

- Node.js
- Native Node HTTP server
- SQLite
- Session cookies
- Nodemailer
- dotenv

## Run Locally

```powershell
npm install
npm start
```

Then open:

- http://localhost:3000

## Environment Variables

Create a `.env` file in the project root:

```env
PORT=3000
SITE_URL=https://your-domain-or-render-url.com
DATA_DIR=/opt/render/project/src/storage
OWNER_EMAIL=belnavo.tech@gmail.com
SMTP_USER=belnavo.tech@gmail.com
SMTP_PASS=your-gmail-app-password
SMTP_FROM=BelNavo tech <belnavo.tech@gmail.com>
FLW_PUBLIC_KEY=your-flutterwave-public-key
FLW_SECRET_KEY=your-flutterwave-secret-key
FLW_SECRET_HASH=your-flutterwave-webhook-hash
```

If SMTP is not configured, the app still works and logs emails locally to `data/mail.log`.
If Flutterwave keys are not configured, the card checkout button will stay disabled.

## Main Features

### Authentication

- Register new users
- Login and logout
- Forgot password and reset password

### Booking and Payments

- Create service bookings
- Track payment status
- Bank transfer flow
- Card payment flow
- Booking notifications to the official email

### Admin Dashboard

- View users
- View orders
- Confirm or cancel payments
- Change order statuses
- View audit logs
- Review analytics

## Backend API

The backend exposes endpoints such as:

- `GET /api/config`
- `GET /api/services`
- `POST /api/auth/register`
- `POST /api/auth/register/verify`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/orders`
- `GET /api/orders`
- `POST /api/payments/bank-transfer`
- `GET /api/admin/users`
- `GET /api/admin/orders`
- `GET /api/admin/stats`

## Presentation Notes

If you need to explain the project, you can say:

> "BelNavo tech uses a custom Node.js backend with SQLite to manage users, bookings, payments, and admin workflows. The frontend talks to the backend through API endpoints, and new accounts are created instantly with secure login afterwards."

## Repository Notes

- The project is ready for GitHub deployment.
- Private runtime files like `.env`, logs, `data/`, and `node_modules/` are ignored.
- For online hosting, Render can run the Node app and keep SQLite data on a persistent disk.

## Deploy To Render

1. Push the latest code to GitHub.
2. Create a new Render Web Service from the `BelNavo.tech` repository.
3. Use the settings from [`render.yaml`](/C:/Users/USER/Documents/New%20project/render.yaml):
   - build command: `npm install`
   - start command: `npm start`
4. Add environment variables in Render:
   - `PORT=3000`
   - `SITE_URL=https://your-render-url.onrender.com`
   - `DATA_DIR=/opt/render/project/src/storage`
   - `OWNER_EMAIL=belnavo.tech@gmail.com`
   - `SMTP_USER=belnavo.tech@gmail.com`
   - `SMTP_PASS=your-gmail-app-password`
   - `SMTP_FROM=BelNavo tech <belnavo.tech@gmail.com>`
   - `FLW_PUBLIC_KEY=...`
   - `FLW_SECRET_KEY=...`
   - `FLW_SECRET_HASH=...`
5. Add a persistent disk if Render does not auto-attach one.
6. In Flutterwave dashboard, set the webhook URL to:
   - `https://your-render-url.onrender.com/api/payments/flutterwave/webhook`
7. After deploy, test:
   - signup and login
   - login
   - booking creation
   - card checkout
   - bank transfer
   - admin confirmation

### Suggested order

- Deploy backend first
- Confirm the live URL works
- Then configure Flutterwave webhook
- Finally test a live card payment
