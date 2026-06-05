# BelNavo tech

BelNavo tech is a service booking website for design, web, branding, motion, and e-commerce work.

It includes:
- user signup and login
- email verification with a 6-digit code
- booking and payment tracking
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
OWNER_EMAIL=belnavo.tech@gmail.com
SMTP_USER=belnavo.tech@gmail.com
SMTP_PASS=your-gmail-app-password
SMTP_FROM=BelNavo tech <belnavo.tech@gmail.com>
```

If SMTP is not configured, the app still works and logs emails locally to `data/mail.log`.

## Main Features

### Authentication

- Register new users
- Email verification before account activation
- Login and logout
- Forgot password and reset password

### Booking and Payments

- Create service bookings
- Track payment status
- Bank transfer flow
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

> "BelNavo tech uses a custom Node.js backend with SQLite to manage users, bookings, payments, and admin workflows. The frontend talks to the backend through API endpoints, and email verification is used before a new account becomes active."

## Repository Notes

- The project is ready for GitHub deployment.
- Private runtime files like `.env`, logs, `data/`, and `node_modules/` are ignored.
