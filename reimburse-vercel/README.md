# Spyne ReimburseDesk

Out-of-pocket employee **reimbursement** claim & approval workflow — a sibling to the Travel (`travel-vercel`) and Expense (`expense-vercel`) apps, reusing the same stack: static UI + Vercel serverless functions + Google Sheets storage + Resend email + domain-locked Google OAuth.

## What it does

An employee who paid for something out of pocket files a **claim** with one or more expense lines (date, category, description, amount, **receipt**). It routes:

```
Dept Head → Finance            (total ≤ ₹50,000)
Dept Head → Finance → CEO      (total >  ₹50,000)
```

Finance records the **payout** once approvals are complete → *Reimbursed & closed*.

- **Net reimbursable** = total claimed − any advance already taken.
- A **receipt is required on every line**.
- Approvers act from the email links (token) **or** the dashboard. Finance is a superuser (sees every view).

## Pages

| Route | Who | What |
|-------|-----|------|
| `/` | everyone | New claim form (multi-line + receipt upload) |
| `/my` | everyone | Track your own claims |
| `/approvals` | HOD / CEO / Finance | Approve / reject / hold queue |
| `/finance` | Finance | Master tracker + record payouts + CSV |
| `/login.html` | — | Branded Google sign-in |

## Functions (10 / 12 Vercel Hobby limit)

`api/auth/{login,callback,logout}`, `api/me`, `api/config`, `api/submit`, `api/decision`, `api/finance`, `api/upload`, `api/cron`.

## Local preview (no creds)

```
node reimburse-vercel/.claude/mock-server.mjs    # http://localhost:8733
```

The mock server serves the static pages and fakes the APIs with demo data (signed in as a Finance superuser).

## Deploy

```
cd reimburse-vercel && vercel --prod --yes --scope ved-prakash-s-projects1
```

### Required env vars (set in the Vercel dashboard)

`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` (single line, literal `\n`),
`SHEET_ID` (its own sheet — must NOT be shared with travel/expense), `GDRIVE_FOLDER_ID` (a Shared Drive folder),
`RESEND_API_KEY`, `FROM_EMAIL`, `CRON_SECRET`.

Optional overrides: `ALLOWED_DOMAIN`, `FINANCE_EMAILS`, `CEO_EMAIL`, `FINANCE_SPOC`, `CEO_THRESHOLD_INR`, `FX_USD_INR`, `APP_BASE_URL`.

The OAuth client needs `https://<deployment>/api/auth/callback` in its Authorized redirect URIs.
See `.env.example`.
