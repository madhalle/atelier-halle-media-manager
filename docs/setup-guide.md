# Setting up real publishing

Platform setup in the app needs a few things only you can create. Never paste
secrets into chats or files. Type them into **Platform setup**, which saves
them to the macOS Keychain.

## 1. Instagram (Meta developer app)

Your Instagram accounts must be **Business** accounts.

Meta apps created since late 2026 only offer **API setup with Unified login**,
which needs a business portfolio and an HTTPS redirect. A loopback app can't
serve HTTPS, so the app uses a **system-user token** from that setup instead
of a sign-in flow. (Older apps with *API setup with Instagram login* can still
use the app ID and secret: see the end of this section.)

1. Create a Meta developer account and an app with the use case **Manage
   messaging & content on Instagram**.
2. Create a **business portfolio** (business.facebook.com), e.g. "Atelier
   Halle". Under **Settings › Accounts › Instagram accounts**, add each
   Instagram account and assign yourself to it with content permissions.
   Require two-factor authentication for everyone.
3. In the developer app, open **Use cases › Customize › API setup with Unified
   login** and select the business portfolio.
4. **Create new configuration** with the least access possible:
   `instagram_basic`, `instagram_content_publish` and `business_management`.
   Choose your Instagram accounts as assets and no ad account. Leave the
   redirect URL empty.
5. Generate the system-user access token (**2. Generate access tokens**, or
   Business settings › System users). Paste it only into **Platform setup ›
   Instagram (Meta business portfolio)**, which saves it to the Keychain.
   - The token doesn't expire. Revoke it in Business settings › System users
     if it may have leaked, then save a new one. Connected accounts use the
     saved token, so replacing or removing it applies to all of them.
6. Assign each Instagram account to the system user (Business settings ›
   Accounts › Instagram accounts › Assign people › the system user ›
   **Content**).
7. For each Instagram tab: **Connect Instagram account**, choose the account,
   then **Connect this account**. If Meta lists no accounts (observed for
   system users), enter the account's ID instead: it's shown under the
   username in Business settings › Accounts › Instagram accounts.
8. Set up R2 (section 3). Instagram can't publish without it.

**Older Meta apps (Instagram Login).** Add each account as an Instagram tester,
register `http://localhost:4870/oauth/instagram/callback` under **Business
login settings › OAuth redirect URIs**, then enter the **Instagram app ID** and
**app secret** in Platform setup › Instagram (older Meta apps). Meta now
requires HTTPS redirects for new apps, so this route may not be available.

## 2. Pinterest (developer app)

Each Pinterest account you'll post to should be a **business** account.

1. Sign in to developers.pinterest.com with a business account, accept the
   Developer Terms, create an app, and request **Trial** access.
   - Website: `https://atelierhalle.com`. Privacy policy URL:
     `https://atelierhalle.com/privacy` (an unlinked Squarespace page; source:
     `docs/privacy-policy.md`). Pinterest requires the policy to be on the
     same domain as the app's website; a separate github.io page was denied.
   - Developer purpose: **Personal API access**. Audience: **Creators** and
     **Businesses**. Reads Pins and/or Boards: **Yes, mine**.
2. Under **Configure › Redirect URIs**, add exactly
   `http://localhost:4870/oauth/pinterest/callback`.
3. In **Platform setup**, enter the **Pinterest app ID** and **app secret**.
   Leave *API access* on **Trial**: Pins go to the sandbox, visible only to
   you. Trial sign-ins get sandbox tokens, which Pinterest accepts only in the
   sandbox, so after switching *API access* reconnect each Pinterest account.
   The sandbox lists only sandbox Boards and Pins, not your public ones.
4. Public Pins need **Standard** access. Apply from *My apps* with a screen
   recording of signing in through this app. Then switch *API access* to
   Standard.

## 3. Cloudflare R2 (media delivery for Instagram)

1. Create a Cloudflare account and enable R2. Note whether it asks for a
   payment method.
2. Create a **private** bucket, e.g. `atelier-halle-staging`. Don't enable
   public access or a custom domain.
3. Add a **lifecycle rule** that deletes objects after **1 day**.
4. Create an **R2 API token** with **Object Read & Write**, limited to that
   one bucket.
5. In **Platform setup**, enter the account ID, the bucket name, the access
   key ID and the secret access key.
   - Copy the account ID from the bucket's **Settings › S3 API** address,
     `https://<account ID>.r2.cloudflarestorage.com/<bucket>`. Cloudflare
     shows several look-alike 32-character IDs; a wrong one makes Cloudflare
     refuse the connection, which looks like a network error.
6. Click **Test connection**. The app uploads a tiny file, reads it back
   through a 60-second link (as Instagram would), and deletes it.

## 4. Connect accounts

For each account tab, open its settings and choose **Connect**. Sign in on the
platform and approve. The app checks the real account and its eligibility,
then asks you to **Mark schedules reviewed** before anything publishes.

## 5. Enable live publishing (only when you're ready)

Live publishing stays off unless the server is started with it:

```sh
MEDIA_MANAGER_LIVE_PUBLISHING=enabled npm start
```

Before the first real post, we'll agree on one test: which account, which
photo and caption, and when. On Instagram the app can be checked up to the
point of publishing (a prepared upload that's never published) without
posting anything.
