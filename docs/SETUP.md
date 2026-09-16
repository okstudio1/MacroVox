# MacroVox Backend Setup Guide (Supabase + Netlify + Stripe)

Step-by-step instructions for setting up MacroVox's backend infrastructure from scratch. MacroVox uses **Supabase** for authentication and database, **Netlify** for hosting serverless functions, and **Stripe** for subscription billing.

> **Managed Pro and Team traffic keeps provider master keys server-side.** BYOK users may configure their own keys locally, but no shared managed key is stored in the client or a user-readable database row.

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create an account
2. Click **New Project**, choose a name and region
3. In **Settings > API**, enable **Data API** (recommended for supabase-js) and **Enable automatic RLS** (security by default)
4. Save your **Project URL** and **anon public key** from `Settings > API`

### Configure environment variables

```
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Create a `.env` file in the project root with Vite-prefixed variables (required for the renderer):

```
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY

# Vite-exposed vars for the renderer (must be prefixed VITE_)
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_KEY=YOUR_PUBLISHABLE_KEY
```

The Supabase client is initialized in `src/renderer/lib/supabase.ts` using `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY`. Session tokens are persisted in `localStorage` by the Supabase JS SDK automatically.

The desktop CSP in `src-tauri/tauri.conf.json` contains the exact hosted
Supabase origin. A custom deployment must replace that origin with its exact
`https://YOUR_PROJECT.supabase.co` value, then run `npm run check:csp`. Do not
use a wildcard CSP source.

---

## Step 2: Enable Auth Providers

In the Supabase dashboard, go to **Authentication > Providers**:

### Email/Password (enabled by default)
- Toggle **Enable Email Signup** on
- Optionally enable **Confirm email** (sends verification link)

### Google OAuth
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (type: Web application)
3. Set **Authorized redirect URI** to: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
4. Copy the Client ID and Client Secret
5. In Supabase dashboard: **Authentication > Providers > Google**, then paste credentials

### Facebook OAuth
1. Go to [Facebook Developers](https://developers.facebook.com/apps)
2. Create an app, add **Facebook Login** product
3. Set **Valid OAuth Redirect URI** to: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
4. Copy the App ID and App Secret
5. In Supabase dashboard: **Authentication > Providers > Facebook**, then paste credentials

### Register custom protocol

For OAuth to work in the Tauri app, the redirect must use the `macrovox://` custom protocol. OAuth currently opens the provider URL in the system browser via `@tauri-apps/plugin-shell`. Deep-link support (`macrovox://auth/callback`) for returning the session is planned for a future phase. Email auth is fully functional.

---

## Step 3: Apply Database Migrations

Do not create billing tables or policies manually. The versioned migrations in
`supabase/migrations` define the tables, RLS policies, grants, atomic quota
reservation, checkout reservation, and webhook event ledger.

```powershell
supabase db push
```

Fresh projects do not create `managed_api_keys`. The upgrade migration clears
any legacy provider credentials and revokes client access to the old table.
Provider master keys must remain in Netlify environment variables only.

The service role is the only caller allowed to execute quota, checkout, and
webhook mutation functions. Authenticated clients can read only their own
subscription summary.

---

## Step 4: Create Stripe Products

1. Go to [Stripe Dashboard](https://dashboard.stripe.com) → **Products**
2. Click **+ Add product**
3. Create **MacroVox** at `\$6.99/month` recurring
   - **Description**: `Customizable voice-to-text with AI post-processing you control. Define custom AI prompts to transform your speech into any format, including meeting notes, code comments, emails, or polished prose. Tailor hotkeys, recording modes, and processing rules to fit your exact workflow.`
4. Save the **Price ID** (starts with `price_`)
5. Optionally create additional tiers

---

## Step 5: Deploy Netlify Functions

The Netlify functions handle the Claude proxy and short-lived Deepgram grants for subscribers.
Billing (Stripe checkout, billing portal, webhook) runs as Supabase Edge Functions. See Step 5b.

### 5a. Create a Netlify site

1. Go to [netlify.com](https://netlify.com), sign in
2. Click **Add new site > Import an existing project**
3. Connect your MacroVox repo
4. Set build settings:
   - **Build command**: (leave empty or `echo no build`)
   - **Publish directory**: `public` (or create an empty folder)
5. Deploy

### 5b. Deploy Supabase Edge Functions (Stripe billing)

Billing functions run in Deno on Supabase's edge network. Deploy them with the Supabase CLI:

```powershell
# Install Supabase CLI if not already installed
npm install -g supabase

# Login and link your project
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# Set secrets (these become Deno.env in the functions)
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_PRO_PRICE_ID=price_...
# Set STRIPE_TEAM_PRICE_ID only when the Team product is ready.
supabase secrets set STRIPE_TEAM_PRICE_ID=price_...
supabase secrets set SITE_URL=https://macrovox.tech

# Apply migrations before deploying the billing functions.
supabase db push

supabase functions deploy create-checkout
supabase functions deploy billing-portal
supabase functions deploy stripe-webhook
```

The webhook URL will be:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook
```
Register this in Stripe Dashboard → Developers → Webhooks with these events:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`

### 5c. Add environment variables to Netlify

In Netlify dashboard: **Site settings > Environment variables**:

```
SUPABASE_SERVICE_ROLE_KEY=eyJ...  (from Supabase Settings > API > service_role)
ANTHROPIC_MANAGED_KEY=sk-ant-... (required for subscriber Claude requests)
DEEPGRAM_MANAGED_KEY=dg_...      (required for short-lived Deepgram grants)
```

The hourly issuance limit per subscriber (`deepgram-grant`'s `RATE_LIMIT_MAX_CALLS`)
is a constant in the function source, not a Netlify environment variable.

> **Note**: Stripe keys are only needed in the Supabase Edge Functions, not in Netlify.

### 5d. Update config.ts

After deploying, update `src/renderer/config.ts` with your Netlify URL:

```typescript
export const SITE_URL = 'https://YOUR-SITE.netlify.app'
```

---

## Step 6: Verify Everything Works

```powershell
python run.py
```

1. **Settings > Sign Up**: create an account with email or Google/Facebook
2. **Settings > Subscription**: should show "Free Plan"
3. **Upgrade to Pro**: completes Stripe checkout and updates entitlement
4. **Dictation**: each managed request should mint a short-lived Deepgram grant
5. **Ctrl+Space**: global hotkey should toggle recording

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────┐
│                    MacroVox (Tauri 2)                  │
│                                                       │
│  Rust backend: audio capture, clipboard, paste, IPC  │
│  React renderer: Supabase Auth JS SDK (email/OAuth)  │
│  Session stored in localStorage (Supabase JS SDK)    │
└───────────┬──────────────────────────┬───────────────┘
            │ auth / billing           │ AI proxy (Bearer JWT)
┌───────────▼──────────────┐  ┌────────▼────────────────┐
│   Supabase (hosted)       │  │   Netlify Functions      │
│  Auth: email, Google, FB  │  │  claude-proxy            │
│  DB: subscriptions, usage │  │  claude + token proxies  │
│                           │  └─────────────────────────┘
│  Edge Functions (Deno):   │
│  create-checkout (Stripe) │
│  billing-portal (Stripe)  │
│  stripe-webhook           │
└───────────────────────────┘
```
