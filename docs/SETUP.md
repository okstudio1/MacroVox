# MacroVox Backend Setup Guide (Supabase + Netlify + Stripe)

Step-by-step instructions for setting up MacroVox's backend infrastructure from scratch. MacroVox uses **Supabase** for authentication and database, **Netlify** for hosting serverless functions, and **Stripe** for subscription billing.

> **MacroVox is a managed service** — Deepgram (speech-to-text) and Claude (AI post-processing) are both required and provisioned server-side for Pro subscribers. Users never configure API keys.

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
5. In Supabase dashboard: **Authentication > Providers > Google** — paste credentials

### Facebook OAuth
1. Go to [Facebook Developers](https://developers.facebook.com/apps)
2. Create an app, add **Facebook Login** product
3. Set **Valid OAuth Redirect URI** to: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
4. Copy the App ID and App Secret
5. In Supabase dashboard: **Authentication > Providers > Facebook** — paste credentials

### Register custom protocol

For OAuth to work in the Tauri app, the redirect must use the `macrovox://` custom protocol. OAuth currently opens the provider URL in the system browser via `@tauri-apps/plugin-shell`. Deep-link support (`macrovox://auth/callback`) for returning the session is planned for a future phase. Email auth is fully functional.

---

## Step 3: Create Database Tables

In the Supabase **SQL Editor**, run:

```sql
-- Subscriptions table
CREATE TABLE subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'pro', 'team')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Legacy table. Both key columns are unused and must stay NULL.
--
-- It used to hold a per-subscriber copy of the shared DEEPGRAM_MANAGED_KEY and
-- ANTHROPIC_MANAGED_KEY, which the client read back with its own session. That
-- put one vendor credential in reach of every subscriber. Managed keys now stay
-- in the function that uses them: ANTHROPIC_MANAGED_KEY in claude-proxy,
-- DEEPGRAM_MANAGED_KEY in deepgram-grant, which exchanges it for a token that
-- expires in a minute. Entitlement is the `subscriptions` row.
--
-- Do not add a key column to any table a client can read. If a future vendor
-- needs one, give it a grant endpoint modelled on deepgram-grant.
CREATE TABLE managed_api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  deepgram_key TEXT,   -- unused, always NULL, revoked from `authenticated`
  anthropic_key TEXT,  -- unused, always NULL, revoked from `authenticated`
  created_at TIMESTAMPTZ DEFAULT now()
);

-- API usage tracking for rate limiting (populated by Netlify proxy functions)
CREATE TABLE api_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  service TEXT NOT NULL,       -- 'claude', 'deepgram' or 'deepgram_grant'
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_api_usage_user_service_time ON api_usage (user_id, service, created_at);

-- Row Level Security (RLS) — users can only read their own data
-- Note: Automatic RLS should be enabled in Settings > API for future tables
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
-- api_usage is written/read only by the service role key (Netlify functions);
-- no user-facing RLS policy needed.

CREATE POLICY "Users read own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- managed_api_keys deliberately has NO policy. RLS is enabled with none
-- defined, which denies the `authenticated` role outright; the service role
-- used by the Netlify and Edge functions bypasses RLS and is unaffected.
--
-- There was a "Users read own keys" policy here. RLS in Postgres is
-- row-level, so it let any signed-in user select `deepgram_key` out of their
-- own row and keep the shared vendor credential. Do not add it back. The
-- entitlement question it was used for is answered by the `subscriptions`
-- policy above, which carries no secret.
REVOKE SELECT (deepgram_key, anthropic_key) ON managed_api_keys FROM authenticated;
REVOKE SELECT (deepgram_key, anthropic_key) ON managed_api_keys FROM anon;
```

---

## Step 4: Create Stripe Products

1. Go to [Stripe Dashboard](https://dashboard.stripe.com) → **Products**
2. Click **+ Add product**
3. Create **MacroVox** — `\$6.99/month` recurring
   - **Description**: `Customizable voice-to-text with AI post-processing you control. Define custom AI prompts to transform your speech into any format — meeting notes, code comments, emails, or polished prose. Tailor hotkeys, recording modes, and processing rules to fit your exact workflow.`
4. Save the **Price ID** (starts with `price_`)
5. Optionally create additional tiers

---

## Step 5: Deploy Netlify Functions

The Netlify functions handle the Claude AI proxy and Deepgram proxy for Pro subscribers.
Billing (Stripe checkout, billing portal, webhook) runs as Supabase Edge Functions — see Step 5b.

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
supabase secrets set STRIPE_PRICE_ID=price_...
supabase secrets set DEEPGRAM_MANAGED_KEY=dg_...
supabase secrets set ANTHROPIC_MANAGED_KEY=sk-ant-...
supabase secrets set SITE_URL=https://macrovox.tech

# Deploy all three billing functions
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
ANTHROPIC_MANAGED_KEY=sk-ant-... (required — Claude key for all subscribers)
DEEPGRAM_MANAGED_KEY=dg_...      (optional — for future server-side transcription proxy)
```

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

1. **Settings > Sign Up** — create account with email or Google/Facebook
2. **Settings > Subscription** — should show "Free Plan"
3. **Upgrade to Pro** — completes Stripe checkout, keys are provisioned
4. **Dictation** — recording should work with managed Deepgram key
5. **Ctrl+Space** — global hotkey should toggle recording

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
│  DB: subscriptions, keys  │  │  deepgram-proxy          │
│                           │  └─────────────────────────┘
│  Edge Functions (Deno):   │
│  create-checkout (Stripe) │
│  billing-portal (Stripe)  │
│  stripe-webhook           │
└───────────────────────────┘
```
