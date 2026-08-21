# Setup: Push Notifications & Email OTP

Two things need external accounts before these features work. Both have
free tiers that cover this project comfortably.

---

## 1. Email OTP (signup verification + password reset)

Needed for: users to register at all. Without SMTP configured the codes
are printed to the server log instead of being emailed — fine locally,
never in production.

### Pick a provider (all free)

| Provider | Free allowance | Notes |
|---|---|---|
| **Brevo** | 300 emails/day | Recommended. No domain needed to start. |
| **Resend** | 3,000/month | Needs a verified domain for best delivery. |
| **Gmail** | ~500/day | Requires an App Password, not your login password. |

### Brevo (recommended)

1. Sign up at brevo.com
2. **SMTP & API** → **SMTP** tab
3. Copy the login and the SMTP key

Then set these environment variables (locally in `.env`, and on Render
under **Environment**):

```
SMTP_HOST="smtp-relay.brevo.com"
SMTP_PORT=587
SMTP_USER="<your brevo smtp login>"
SMTP_PASS="<your brevo smtp key>"
MAIL_FROM="Strong XI <no-reply@yourdomain.com>"
```

> `MAIL_FROM` should use a domain you control. A mismatched from-address
> is the most common reason codes land in spam.

### Verify it works

Register a new account in the app. The code should arrive within a few
seconds. If it doesn't, check the server logs — a misconfigured SMTP
setup logs a warning with the code in it, so you can still get in.

---

## 2. Push notifications (Android)

Needed for: any push at all. Android delivery goes through Firebase
Cloud Messaging, which is free.

### a) Create a Firebase project

1. Go to console.firebase.google.com → **Add project**
2. Skip Google Analytics (not needed)
3. Add an **Android app**
   - Package name must exactly match `expo.android.package` in
     `app.json`. If that field doesn't exist yet, add it, e.g.
     `com.strongxi.app`
4. Download **`google-services.json`** and put it in the app project
   root, next to `app.json`

`app.json` already points at it:

```json
"android": { "googleServicesFile": "./google-services.json" }
```

### b) Give Expo the FCM credential

Expo's push service needs permission to talk to your Firebase project.

1. Firebase console → **Project settings** → **Service accounts**
2. **Generate new private key** — downloads a JSON file
3. In the app project, run:

```bash
npx eas credentials
# Android → production → Google Service Account
# → Manage your Google Service Account Key for Push Notifications (FCM V1)
# → Upload a new service account key → pick the JSON you downloaded
```

### c) Set the EAS project ID

`expo-notifications` needs to know which Expo project the token belongs
to. If `app.json` has no `extra.eas.projectId`, run:

```bash
npx eas init
```

which fills it in for you.

### d) Build

**Push does not work in Expo Go.** You need a development or production
build:

```bash
npx eas build --profile development --platform android
```

Install that APK on a real device — emulators can't receive push either,
which is why `registerForPush()` checks `Device.isDevice` and quietly
does nothing otherwise.

### e) Test

1. Open the app on the device and log in — the token registers itself
2. Admin panel → **Push Notifications** → send one

The admin page shows how many devices are registered. If it says 0, no
token reached the server: check that the app was a real build, on a real
device, with notification permission granted.

---

## iOS

Push is deliberately Android-only for now. iOS tokens are never
requested, so there's nothing to filter server-side.

To turn iOS on later you'll need an Apple Developer account
($99/year) for APNs credentials. Once that's in place, the only code
change is `PUSH_PLATFORMS` in `src/utils/push.ts`:

```ts
const PUSH_PLATFORMS: string[] = ["android", "ios"];
```

Everything else — token storage, sending, scheduling — already handles
both platforms.

---

## What sends automatically

Configured under **Settings → Automatic notifications** in the admin
panel. Each can be switched off individually, and `pushEnabled` is the
master switch.

| Event | Goes to |
|---|---|
| Admin gives bonus coins | That user |
| Gift request approved / cancelled | That user |
| Contest prizes paid out | Each winner |
| Match about to lock | Everyone, once per match |

The match reminder and scheduled announcements are checked whenever an
app sends its heartbeat (every few minutes), because this host has no
cron. That's precise enough for a reminder measured in tens of minutes —
but it does mean **nothing fires if literally no one has the app open**.
For a scheduled announcement at 3am with zero active users, it will go
out as soon as the first person opens the app.
