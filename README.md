# KRS Offload Scanner

Barcode scanning + live dashboard for **KRS Moving Solutions** furniture
offload and installation jobs. Built for the Michigan Office Environments
partnership.

**Stack:** plain HTML/CSS/JS, Airtable (database), Netlify serverless
functions (API middleware so the Airtable key stays server-side).

---

## What's in the box

| File | What it does |
|---|---|
| `index.html` | Landing page with links to Scanner and Dashboard |
| `scanner.html` + `js/scanner.js` | Mobile barcode scanner for KRS crew on the dock |
| `dashboard.html` + `js/dashboard.js` | Live status view for mgmt + dealer |
| `css/style.css` | All styles (navy + orange brand colors, mobile-first) |
| `netlify/functions/*.js` | Serverless API endpoints that talk to Airtable |
| `netlify.toml` | Tells Netlify where the functions live |

---

## 1. Set up the Airtable base

Create a new Airtable base (or use an existing one) with **three tables**.
The field names must match exactly.

### Table: `Jobs`
| Field | Type |
|---|---|
| Job ID | Autonumber |
| Job Name | Single line text |
| Dealer | Single line text (default: "Michigan Office Environments") |
| Delivery Date | Date |
| Status | Single select: `Scheduled`, `In Progress`, `Completed` |
| Location/Site Name | Single line text |
| Notes | Long text |

### Table: `Products`
| Field | Type |
|---|---|
| Product ID | Single line text *(this is the barcode value)* |
| Description | Single line text |
| Manufacturer | Single line text |
| Job | Linked record → `Jobs` |
| Expected Quantity | Number |
| Received Quantity | Number |
| Scan Status | Single select: `Pending`, `Received`, `Damaged`, `Missing` |
| Scanned By | Single line text |
| Scanned At | Date/time |
| Notes | Long text |
| Photo | Attachment |

### Table: `Scan Log`
| Field | Type |
|---|---|
| Scan ID | Autonumber |
| Product | Linked record → `Products` |
| Job | Linked record → `Jobs` |
| Barcode Value | Single line text |
| Timestamp | Date/time |
| Scanned By | Single line text |
| GPS Coordinates | Single line text |
| Scan Type | Single select: `Offload`, `Installation Confirm`, `Damage Report` |
| Notes | Long text |

> **Tip:** pre-load `Products` rows for each upcoming job so the scanner
> has a manifest to check against. Unknown barcodes can also be added
> on the fly from the scanner.

---

## 2. Get your Airtable credentials

You need two values for Netlify:

1. **`AIRTABLE_API_KEY`** — a personal access token from
   <https://airtable.com/create/tokens> with the scopes
   `data.records:read`, `data.records:write`, and access to your base.
2. **`AIRTABLE_BASE_ID`** — from your base URL (`https://airtable.com/appXXXXXXXXXXXXXX/...`).

---

## 3. Deploy on Netlify

1. Push this repo to GitHub (already done if you cloned it).
2. In Netlify, click **Add new site → Import from Git**, pick the
   `krs-offload-scanner` repo.
3. Build settings — leave build command blank, publish directory = `.`
   (this is already set in `netlify.toml`).
4. **Site settings → Environment variables**, add:
   - `AIRTABLE_API_KEY` = *your token*
   - `AIRTABLE_BASE_ID` = *your base id*
5. Deploy.

Your site will be live at something like
`https://krs-offload-scanner.netlify.app`

- `/scanner.html` — the mobile scanner
- `/dashboard.html` — the shared live dashboard
- `/.netlify/functions/get-jobs` etc. — the API endpoints

---

## 4. Using the scanner

1. Open the site on your phone → **Open Scanner**
2. Pick your name + the active job
3. Tap **SCAN**, point camera at barcode
4. The phone beeps + vibrates on a successful scan
5. Unknown barcode? You'll get prompted to add it on the spot
6. See a damaged piece? Tap **REPORT DAMAGE**, scan it, add a note + photo

Works offline — scans are queued in `localStorage` and auto-sync when
connection returns.

---

## 5. Using the dashboard

- Open `/dashboard.html` on any device
- Pick the job from the dropdown
- Live progress bar, summary cards, filterable manifest
- Right sidebar shows the last 10 scans, refreshes every 15s
- Full table refreshes every 30s
- **Export CSV** downloads the manifest for the dealer

---

## Notes / future enhancements

- Add basic auth or Netlify Identity to protect the dashboard
- Swap photo attachment from data URL to a real upload (S3 / Cloudinary)
- Slack / email alert when a job hits 100% or when damage is reported
- Optional kiosk mode showing dashboard on a wall-mounted tablet

---

_Built for KRS Moving Solutions × Michigan Office Environments._
