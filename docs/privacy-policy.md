# Atelier Halle Media Manager — Privacy Policy

_Last updated: October 30, 2026_

Atelier Halle Media Manager ("the app") is a private tool used by Atelier
Halle to prepare and schedule posts to its own Instagram and Pinterest
accounts. It is not offered to the public, and it is used only by its owner.

## What the app accesses

When an account is connected, the app uses the official Pinterest and
Instagram APIs to access only what it needs to publish:

- Basic account details: account ID, username and account type, to confirm
  the right account is connected.
- Pinterest boards, so a board can be chosen for each Pin.
- Permission to create Pins and Instagram posts on the connected account.

The app does not read followers, messages, analytics or other people's data.

## Where data is stored

- Everything stays on the owner's own computer. There is no app server,
  account system or cloud database.
- Access tokens are stored in the macOS Keychain and are never written to
  ordinary files or logs.
- Photos and captions are stored locally and sent only to the platform they
  are being published to.
- For Instagram only, each photo is placed briefly in private Cloudflare R2
  storage so Instagram can fetch it, then deleted. It is reachable only
  through a link that expires within 15 minutes.

## Sharing

No data is sold, shared with third parties or used for advertising. The app
contains no analytics or tracking.

## Deleting data

Disconnecting an account in the app deletes its stored tokens immediately.
Access can also be revoked at any time from the connected-apps section of
the Pinterest or Instagram account settings.

Deleting the app's local data folder removes everything else it stored.
