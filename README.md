# Bundle Discount Webhook (SHEER Shopify)

Serverless function for the SHEER Taiga theme bundle feature. When a Shopify **collection** is updated, this handler reads bundle metafields on that collection and automatically creates, updates, or deletes **discount codes** in Shopify Admin.

Designed to run on **Vercel** as a standalone project (separate from the theme repo). [Vercel](https://vercel.com)

---

## What it does

```
Shopify: Collection updated webhook
        ↓
Vercel:  POST /api/shopify/webhook
        ↓
        Verify HMAC signature
        ↓
        Fetch collection bundle metafields (GraphQL)
        ↓
        For each bundle tier → create/update Price Rule + Discount Code
        OR if bundle disabled → delete existing bundle discounts
```

### Trigger

| Webhook topic | Action |
|---------------|--------|
| **Collections / Update** | Main trigger — syncs discount codes for that collection |
| **Products / Update** | Acknowledged only (no discount sync; price metafield is set manually) |

Shopify does not expose a dedicated “collection metafield updated” event, so **Collection updated** is used. Saving a collection after changing bundle metafields fires the webhook.

### Discount output

For each bundle tier, the function creates:

| Item | Format | Example |
|------|--------|---------|
| **Discount code** | `BDL-{quantity}P-{BUNDLE_GROUP_ID}` | `BDL-2P-FEATHERS-BUNDLE` |
| **Price rule title** | `Bundle Discount - {Collection Title} - {quantity}-Pack` | `Bundle Discount - Feathers Bundle - 2-Pack` |

Discount amount is calculated as:

```
discount = (base_product_price × quantity) − tier_bundle_price
```

Price rules apply a **fixed amount off** products in the **specific collection** only (`entitled_collection_ids`).

When `bundle_enabled` is `false`, matching price rules for that collection are deleted.

---

## Shopify prerequisites

### 1. Collection metafields (`custom` namespace)

These must exist on bundle **sibling collections** (the collection referenced by products’ `theme.siblings` metafield in the theme):

| Metafield key | Type | Required | Purpose |
|---------------|------|----------|---------|
| `bundle_enabled` | Boolean | Yes | Turn bundle discounts on/off for this collection |
| `bundle_tiers` | List of metaobject references | Yes | Tier definitions (quantity + price) |
| `bundle_group_id` | Single line text | Recommended | Stable ID for discount codes; defaults to collection handle |
| `bundle_base_product_price` | Number (decimal) | **Yes** | Base product price in store currency (e.g. `153.00`) used to calculate discount |

### 2. Bundle tier metaobject

Each entry in `bundle_tiers` should be a metaobject with at least:

| Field | Type | Example |
|-------|------|---------|
| `quantity` | Integer | `2` |
| `price` | Decimal | `280.00` (total bundle price for that quantity) |
| `discount_percent` | Decimal | Optional; not used by this function for calculation |

### 3. Theme integration

The Taiga theme expects discount codes in the format above and applies them at cart/checkout. See `Taiga-WIP/docs/BUNDLE_DISCOUNT_TEST_PLAN.md` for end-to-end testing.

### 4. Manual step after creation

The function **cannot** set `combines_with` via the REST API used here. After discounts are created, configure **combines with other discounts** in Shopify Admin if needed.

---

## Shopify Admin API app

Create a **custom app** in Shopify Admin (Settings → Apps and sales channels → Develop apps).

### Required Admin API scopes

- `read_products`, `write_products` (optional; product webhook is passive)
- `read_discounts`, `write_discounts`
- `read_metaobjects`, `read_metaobject_definitions`
- `read_content` or collection read access (for collection metafields via GraphQL)

Generate an **Admin API access token** and note your shop domain: `sheer-2.myshopify.com`.

API version used by the function: **2025-10**.

---

## Vercel deployment

### 1. Connect the repo

1. Push this project to GitHub (or connect the local folder).
2. In [Vercel](https://vercel.com), **Add New Project** → import the repo.
3. Framework preset: **Other** (no build step required).
4. Deploy.

### 2. Webhook URL

After deploy, your endpoint is:

```
https://<your-vercel-project>.vercel.app/api/shopify/webhook
```

(`vercel.json` rewrites this path to `api/shopify/webhook.js`.)

### 3. Environment variables

In Vercel → Project → **Settings → Environment Variables**, add the variables below.

For **this project's current values**, copy from `.env.local` in the repo root (local file, not committed). Use that file as the source of truth when configuring Vercel or running locally.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SHOPIFY_STORE` | **Yes** | Shop domain (no `https://`) | `sheer-2.myshopify.com` |
| `SHOPIFY_API_TOKEN` | **Yes** | Admin API access token | `shpat_...` |
| `SHOPIFY_WEBHOOK_SECRET` | **Yes** | Webhook signing secret from Shopify | From webhook or app settings |
| `SKIP_WEBHOOK_VERIFICATION` | No | Bypass HMAC signature check when set to `true` (see below) | `true` |
| `SHOPIFY_SHOP_DOMAIN` | No | Read in handler but unused; safe to omit | — |

> **Note:** Processing uses `SHOPIFY_STORE`. Set it to your `.myshopify.com` domain.

#### `SKIP_WEBHOOK_VERIFICATION`

Optional workaround for HMAC verification failures on Vercel (where JSON body parsing can invalidate the signature check).

| Value | Behavior |
|-------|----------|
| unset or `false` | HMAC must match; mismatches return **401 Unauthorized** |
| `true` | HMAC mismatch is logged but the request is still processed |

- **Local dev:** set to `true` in `.env.local` if webhooks fail with 401.
- **Production:** leave unset or set to `false`. Do not enable in production unless you accept unverified webhook requests.

Redeploy after adding env vars.

### 4. Register Shopify webhooks

In Shopify Admin → **Settings → Notifications → Webhooks** (or via your custom app):

| Event | Format | URL |
|-------|--------|-----|
| Collection update | JSON | `https://<your-vercel-project>.vercel.app/api/shopify/webhook` |

Optional (logged only, no discount changes):

| Event | Format | URL |
|-------|--------|-----|
| Product update | JSON | Same URL |

Copy the **webhook signing secret** Shopify shows into `SHOPIFY_WEBHOOK_SECRET` in Vercel.

---

## HMAC verification on Vercel

Shopify signs webhooks with HMAC-SHA256 over the **raw request body**. Vercel may parse JSON before your handler runs, which can break verification when the body is re-stringified.

**Production options:**

1. **Preferred:** Disable automatic body parsing and read the raw stream (requires a small code change + `export const config = { api: { bodyParser: false } }` if using the Pages-style handler).
2. **Testing only:** Set `SKIP_WEBHOOK_VERIFICATION=true` to bypass verification while debugging. **Remove this in production.**

If verification fails, check Vercel function logs for `Webhook verification failed` and compare expected vs calculated HMAC.

---

## Local development

```bash
npm install   # no dependencies, but installs project metadata
npx vercel dev
```

Local URL (default):

```
http://localhost:3000/api/shopify/webhook
```

Use [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) or Admin to send test webhooks to your tunnel (e.g. `vercel dev` or ngrok).

Create a `.env.local` file in the project root (do not commit). This repo keeps the **current service values** there — use it as the template for local dev and when setting the same variables in Vercel:

```env
# See .env.local in this repo for current SHEER service values
SHOPIFY_STORE=sheer-2.myshopify.com
SHOPIFY_API_TOKEN=shpat_...
SHOPIFY_WEBHOOK_SECRET=your_webhook_secret
SKIP_WEBHOOK_VERIFICATION=true
```

---

## How to use (merchant workflow)

1. **Configure the sibling collection** in Shopify Admin:
   - Set `Bundle enabled` = true
   - Set `Bundle base product price` (e.g. `153.00`)
   - Set `Bundle group ID` (e.g. `FEATHERS-BUNDLE`) — used in discount codes
   - Add `Bundle tiers` metaobjects (2-pack, 3-pack, etc. with prices)

2. **Save the collection** — Shopify sends a Collection updated webhook.

3. **Wait ~2 seconds** — the function intentionally delays to reduce API rate-limit collisions.

4. **Verify in Shopify Admin** → Discounts:
   - Codes like `BDL-2P-FEATHERS-BUNDLE` should appear
   - Price rules titled `Bundle Discount - {Collection} - {N}-Pack`

5. **Test on storefront** — add a bundle via the theme; cart should apply the matching `BDL-*` code (see theme test plan).

### Disable bundles

Set `bundle_enabled` to `false` and save the collection. The function deletes existing bundle price rules for that collection title.

### Update pricing

Change `bundle_base_product_price` or tier prices, then save the collection. Existing rules are updated when the discount amount changes; unchanged amounts are skipped.

---

## Rate limiting

Shopify Admin API allows ~2 requests/second. This function:

- Queues API calls with a **1 second minimum** between requests
- Retries **429** responses with exponential backoff (up to 5 attempts)
- Waits **2 seconds** after receiving a collection webhook before processing
- Pre-fetches all price rules once per collection update (instead of per tier)

Typical collection update: ~5 API calls (down from ~11 in earlier versions).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401 Unauthorized` | HMAC verification failed | Verify `SHOPIFY_WEBHOOK_SECRET`; for local dev only, set `SKIP_WEBHOOK_VERIFICATION=true` |
| `SHOPIFY_STORE environment variable is not set` | Missing env var | Set `SHOPIFY_STORE` in Vercel and redeploy |
| No discount codes created | Missing/invalid `bundle_base_product_price` | Set metafield on collection; check Vercel logs |
| `Bundle not enabled` | `bundle_enabled` is false | Enable metafield or expect cleanup only |
| `No bundle tiers found` | Empty `bundle_tiers` | Add tier metaobjects to collection |
| Discount amount is $0 | Tier price ≥ regular total | Lower tier price or raise base product price |
| Orphaned price rules | Code creation failed mid-run | Re-save collection; function retries on next webhook |
| `429 Rate limited` | Too many Admin API calls | Wait and re-trigger; function retries automatically |

Check **Vercel → Deployments → Functions → Logs** for detailed step-by-step output (`📦 Processing tier`, `✅ Created discount code`, etc.).

---

## Project structure

```
bundle-metafield-sync/
├── api/
│   └── shopify/
│       └── webhook.js    # Main serverless handler
├── vercel.json           # Route rewrite + function config
├── package.json
└── README.md
```

---

## Security notes

- Never commit `.env`, `.env.local`, API tokens, or webhook secrets.
- Use `.env.local` locally for current values; mirror those variables in Vercel (Production / Preview) without committing them.
- Do not leave `SKIP_WEBHOOK_VERIFICATION=true` in production.
- Restrict Admin API token scopes to what is listed above.
- Webhook endpoint accepts **POST** only.

---

## Related documentation

- Theme bundle UI: `Taiga-WIP/snippets/product-bundle-modal-liquid.liquid`, `product-bundle-button.liquid`
- Storefront test plan: `Taiga-WIP/docs/BUNDLE_DISCOUNT_TEST_PLAN.md`
- [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook)
