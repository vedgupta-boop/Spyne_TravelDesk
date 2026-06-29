# Spyne ExpenseDesk — Vercel App

An expense / purchase **request + approval workflow** that runs on **Vercel**: static UI +
serverless API functions, **Google Sheets** for storage, **Resend** for email. Built as a
sibling to the Travel app, using the same stack and design system.

```
Requester form (/)  →  POST /api/submit  →  Google Sheets row
                                          →  email HOD (Approve/Reject links, approver named in body)
   HOD approve  →  /api/decision  →  Sanjay (CEO, only if > ₹50k) → Finance → Approved
   Approvals (/approvals)  ·  Finance master tracker (/finance)
```

## Approval routing (Expense Approval SOP v1.0)

The threshold is checked on the **per-transaction** amount, normalised to INR
(USD × `FX_USD_INR`, default 92). The annualised value is still shown for context.

| Per-transaction amount | Chain |
|---|---|
| **Up to ₹50,000** | Dept Head → Finance |
| **Above ₹50,000** | Dept Head → **Sanjay (CEO)** → Finance |

Finance is **always** the final approver. Approver links carry a token stored in the sheet;
it rotates after each decision, so links can't be reused.

## Layout
```
index.html        Requester form         api/config.js     departments + policy
my.html           My requests            api/submit.js     POST a request
approvals.html    HOD/CEO/Finance queue  api/decision.js   approve / reject / hold
finance.html      Finance master tracker api/finance.js    dashboard data
department.html   HOD/CEO overview       api/me.js         session + my requests
lib/config.js     Config + policy        api/upload.js     quotation/invoice → Drive
lib/workflow.js   Chain + orchestration  api/cron.js       24h reminders (Vercel Cron)
lib/sheets.js     Google Sheets I/O      api/auth/*        Google sign-in (domain-locked)
lib/email.js      Resend + email HTML
lib/drive.js      Drive upload (optional)
```

## Roles (derived from email)
- **Requester** — any `@spyne.ai` account. Submits + sees `/my`.
- **HOD** — anyone listed as a department head in `lib/config.js`. Approves their dept.
- **CEO (Sanjay)** — `CEO_EMAIL`. Approves high-value (> ₹50k) requests.
- **Finance** — `FINANCE_EMAILS`. Final approver + master tracker. Superuser (sees all views).

## Prerequisites & Deploy

Same as the Travel app. Use a **separate Google Sheet** (`SHEET_ID`). Set the env vars from
`.env.example`, then:

```bash
cd expense-vercel
npm install
vercel            # first run: links/creates the project
# add env vars in the Vercel dashboard or via `vercel env add ...`
vercel --prod
```

Authorized OAuth redirect URI: `https://<your-app>/api/auth/callback`.

## Local preview (no Google/Resend needed)

```bash
node .claude/mock-server.mjs      # serves UI + mocked API on http://localhost:8732
```

The mock signs you in as a superuser with seeded demo requests so every dashboard renders.

## Notes
- Headers and rows are created automatically in the sheet on first submit.
- `GOOGLE_PRIVATE_KEY` must keep its `\n` escapes (the code converts them to newlines).
- `FX_USD_INR` (default 92) is only used to normalise USD amounts for the ₹50k per-transaction threshold check — it is not an accounting rate.
