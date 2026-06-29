# Spyne — Travel Request Form & Approval Workflow

A single **Google Apps Script web app** with three views: a traveller request
form, itemised approval emails, and a finance cost-tracking dashboard. Requests
auto-route through a policy-driven approval chain and flag over-budget items.

```
Traveller submits the form (web app)
   └─ Costs computed server-side vs. policy caps
       └─ HOD            → Approve / Reject (email buttons)
            └─ CEO        → (international only)
                 └─ Finance → Approve / Reject (email buttons)
                      └─ Admin team notified to make arrangements
   Any rejection → requester is notified, flow stops.
```

**Approval chain is automatic by travel type:**

| Travel type | Currency | Chain |
|---|---|---|
| Local / within-city | INR | HOD → Admin |
| Domestic outstation | INR | HOD → Finance → Admin |
| International | USD | HOD → CEO → Finance → Admin |

Approvers click **Approve / Reject buttons inside the email** — no spreadsheet
access needed. Everything is tracked in a Google Sheet and surfaced in the
finance dashboard.

---

## The three views

1. **Traveller form** — the web app's default page. The traveller picks a
   department (HOD auto-fills), travel type (currency + meal per-diem + hotel cap
   + approval chain all set automatically), trip direction (one-way / round-trip,
   with an optional different return city), and dates (duration auto-calculated).
   A live cost summary shows transport, hotel, meals, local travel, other, total.
2. **Approver email** — sent on submit and at each stage. Contains an **itemised
   cost breakdown**: transport, hotel (rate × nights), meals (per-diem × days),
   local travel, other, currency, and total — plus the budget-policy check.
3. **Finance dashboard** — `?page=finance`. KPI cards (pipeline & approved cost
   per currency) and a filterable table of every request with full cost columns
   and live totals.

---

## What's in here

| File | Purpose |
|------|---------|
| `Code.gs` | Backend: routing, cost engine, approval workflow, emails, sheet I/O. |
| `Form.html` | The traveller request form (served via `HtmlService`). |
| `Finance.html` | The finance cost-tracking dashboard. |
| `spyne-travel-request-form.html` | Original rich standalone mockup (reference only — not used by the deployed app). |
| `README.md` | This file. |

---

## One-time setup (≈ 10 minutes)

### 1. Create the Apps Script project
1. Go to **https://script.google.com** → **New project**.
2. Replace the default `Code.gs` contents with this folder's `Code.gs`.
3. Add two HTML files: **File → New → HTML file**, name them exactly **`Form`**
   and **`Finance`** (Apps Script appends `.html` itself). Paste in the contents
   of `Form.html` and `Finance.html` respectively.
4. Rename the project (top-left) to e.g. *Travel Request Workflow*.

> Use the company Workspace account (e.g. `accounts@spyne.ai`) so emails send
> from a company address and domain restriction works.

### 2. Fill in the CONFIG block
At the top of `Code.gs`, edit `CONFIG`:
- `COMPANY_DOMAIN` — `spyne.ai`
- `DEPARTMENTS` — each department → `{ head, email }`. **These names become the
  form's Department dropdown, and the email is who the HOD approval routes to.**
- `CEO_EMAIL` — international requests route through this address after the HOD.
- `FINANCE_SPOC` — the finance approver.
- `ADMIN_TEAM` — the team that books travel after final approval.

Policy caps & per-diems live in the `POLICY` block just below CONFIG
(hotel caps per city tier, meal per-diems, local-travel cap). Edit them there.

### 3. Initialise storage
1. In the editor toolbar select **`setup`** → **Run**.
2. Authorize when prompted (review scopes → Allow).
3. **View → Logs** prints the **Responses sheet** URL — that's where everything
   is tracked. (The sheet is created automatically with all columns.)

### 4. Deploy the Web App
1. **Deploy → New deployment** → gear icon → **Web app**.
2. Set:
   - **Execute as:** *Me* (your Workspace account)
   - **Who has access:** *Anyone within Spyne* (your domain)
3. **Deploy** → authorize if asked → copy the **Web app URL**.
4. Back in the editor, run **`registerWebAppUrl`** once.
   (If you forget, the first visit/submit self-heals and caches it anyway.)

### 5. Share the links
- **Traveller form:** the Web app URL.
- **Finance dashboard:** the Web app URL **+ `?page=finance`**.

### 6. Test it
Submit the form once yourself. As the configured HOD/Finance/Admin you'll receive
the approval emails and can click Approve → … → Admin notification. Then open
`?page=finance` to see it tracked.

---

## How approvers act
Each approver gets an email with green **APPROVE** / red **REJECT** buttons and the
full cost breakdown. Clicking opens a confirmation page and advances (or stops)
the workflow. Tokens rotate after each decision, so a link can't be reused or replayed.

## Where to see status
- **Finance dashboard** (`?page=finance`) — the easy view.
- **Responses sheet** — the raw record. Columns track status, stage, every cost
  category, the budget flag, and each approver's decision + timestamp.

---

## Common adjustments
- **Add a department:** add a `'Name': { head, email }` line in `CONFIG.DEPARTMENTS`.
  No re-run needed — the form reads departments live on load.
- **Change caps / per-diems:** edit `POLICY` (applies to new submissions immediately).
- **Add / change a tier-A city:** edit `POLICY.INDIA_TIER_A` / `POLICY.US_TIER_A`.
- **Change the approval chain:** edit `chainFor_(type)` in `Code.gs`.
- **Stop CC'ing the requester:** set `CONFIG.CC_REQUESTER_ON_UPDATES = false`.

## Notes / limits
- **Re-deploy after editing any file:** *Deploy → Manage deployments → Edit →
  Version: New version → Deploy*, so the live web app picks up `Code.gs`/HTML changes.
- `MailApp` daily send quota: 100/day consumer Gmail, 1,500/day Workspace.
- Budget flagging is advisory — it surfaces over-cap requests to approvers; it
  does not auto-reject them.
- Costs are recomputed **server-side** on submit (the form's live summary is a
  preview); the sheet and emails always reflect the authoritative server numbers.
