# Setting up real publishing

Platform setup in the app needs a few things only you can create. Never paste
secrets into chats or files. Type them into **Platform setup**, which saves
them to the macOS Keychain.

## 1. Instagram (Meta developer app)

Your Instagram accounts must be **Business** (or Creator) accounts.

1. Create a Meta developer account and an app with the **Instagram** product,
   set to *API setup with Instagram login*. You don't need a Facebook Page.
2. Under **App roles**, add each Instagram account you'll post to as an
   **Instagram tester**. Accept each invite while signed in to that account.
   Keep the app in Development mode. Standard Access covers accounts you own.
3. Under **Business login settings › OAuth redirect URIs**, add exactly
   `http://localhost:4870/oauth/instagram/callback`.
   - If Meta refuses `http`, tell me; the app would then need local HTTPS.
   - If it wants `127.0.0.1` instead, pick that in the app's *Redirect host*.
4. In the app, open **Platform setup** and enter the **Instagram app ID** and
   **app secret**.
5. Set up R2 (section 3). Instagram can't publish without it.

## 2. Pinterest (developer app)

Each Pinterest account you'll post to should be a **business** account.

1. Sign in to developers.pinterest.com with a business account, accept the
   Developer Terms, create an app, and request **Trial** access.
   - Pinterest needs an accessible **privacy policy URL** for your app, which
     is still to decide. I can draft one.
2. Under **Configure › Redirect URIs**, add exactly
   `http://localhost:4870/oauth/pinterest/callback`.
3. In **Platform setup**, enter the **Pinterest app ID** and **app secret**.
   Leave *API access* on **Trial**: Pins go to the sandbox, visible only to
   you.
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
5. In **Platform setup**, enter the account ID (32 hex characters), the bucket
   name, the access key ID and the secret access key.

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
