# Spyne Travel Request — Vercel App

A full travel-request + approval workflow that runs on **Vercel**: static UI +
serverless API functions, **Google Sheets** for storage, **Resend** for email.

```
Traveller form (/)  →  POST /api/submit  →  cost engine + Google Sheets row
                                          →  email HOD (Approve/Reject links)
   HOD approve  →  /api/decision  →  CEO (intl only) → Finance → Admin
   Finance view (/finance)  ←  GET /api/finance  ←  Google Sheets
```

Approval chain is automatic by travel type: local = HOD→Admin, domestic =
HOD→Finance→Admin, international = HOD→CEO→Finance→Admin.

## Layout
```
index.html        Traveller form        api/config.js     departments + policy
finance.html      Finance dashboard     api/submit.js     POST a request
lib/config.js     Config + policy       api/finance.js    dashboard data
lib/costs.js      Cost engine           api/decision.js   approve / reject links
lib/sheets.js     Google Sheets I/O
lib/email.js      Resend + email HTML
lib/workflow.js   Chain + orchestration
```

## Prerequisites (one-time)

### 1. Google Sheets service account
1. In **Google Cloud Console** → create/pick a project → **Enable APIs** → enable **Google Sheets API**.
2. **Credentials → Create credentials → Service account**. Create a **JSON key** and download it.
3. Create a Google Sheet (any blank one). Copy its **ID** from the URL
   (`docs.google.com/spreadsheets/d/<ID>/edit`).
4. **Share** that sheet with the service account's email (`...iam.gserviceaccount.com`) as **Editor**.
   Headers and rows are created automatically on first submit.

### 2. Resend
1. Sign up at **resend.com**, **verify your sending domain** (e.g. `spyne.ai`).
2. Create an **API key**.
3. Pick a `FROM_EMAIL` on the verified domain (e.g. `Spyne Travel <travel@spyne.ai>`).

### 3. Environment variables
Copy `.env.example` → set each value (see that file for details):
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEET_ID`,
`RESEND_API_KEY`, `FROM_EMAIL`, and optionally `CEO_EMAIL` / `FINANCE_SPOC` /
`ADMIN_TEAM` / `APP_BASE_URL`.

## Deploy

```bash
cd travel-vercel
npm install
vercel            # first run: links/creates the project
# add env vars (repeat for each, or paste in the Vercel dashboard → Settings → Environment Variables):
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
vercel env add GOOGLE_PRIVATE_KEY
vercel env add SHEET_ID
vercel env add RESEND_API_KEY
vercel env add FROM_EMAIL
vercel --prod     # deploy to production
```

- Traveller form: the deployment URL (`/`)
- Finance dashboard: `/finance`

## Local development
```bash
npm install
vercel dev        # serves static UI + /api functions at http://localhost:3000
```
Without env vars the UI loads, but submitting needs the Sheets + Resend values.

## Notes
- Costs are recomputed **server-side** on submit; the form's live summary is a preview.
- Approval links carry a token stored in the sheet; it rotates after each decision,
  so links can't be reused.
- `GOOGLE_PRIVATE_KEY` must keep its `\n` escapes (the code converts them to newlines).

## Deployment

This app is deployed via **Vercel’s GitHub integration** — every push to `main` auto-deploys (root directory: `travel-vercel`). No manual CLI deploys.
