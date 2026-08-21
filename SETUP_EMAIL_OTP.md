# Setup: Email OTP with Gmail

The app sends a 6-digit code for signup verification and password reset.
Without SMTP configured, codes are only printed to the server log — fine
while testing, but nobody can register in production.

Gmail's free tier sends ~500 emails/day, which is plenty here.

---

## Step 1 — Turn on 2-Step Verification

App Passwords do not exist without it. Google hides the option entirely
until 2FA is on.

1. Go to <https://myaccount.google.com/security>
2. **How you sign in to Google** → **2-Step Verification**
3. Follow the prompts (phone number or authenticator app)
4. Confirm it shows **2-Step Verification: On**

---

## Step 2 — Create an App Password

The page is unlisted — you can't reach it through the normal menus, so
use the direct link:

1. Open <https://myaccount.google.com/apppasswords>
2. Under **App name**, type something memorable: `Strong XI`
3. Click **Create**
4. Google shows a 16-character password in a yellow box, split into four
   groups: `abcd efgh ijkl mnop`

**Copy it immediately — it's shown only once.** If you lose it, just
delete that entry and create another.

> **Remove the spaces** when you paste it. Gmail usually accepts them,
> but spaces in an environment variable cause subtle failures that are
> painful to debug. Use `abcdefghijklmnop`, not `abcd efgh ijkl mnop`.

### If the page says "This setting is not available for your account"

- 2-Step Verification isn't actually on — go back to Step 1
- Or the account is on Advanced Protection, which blocks app passwords
- Or it's a Workspace account and your admin has disabled SMTP auth

---

## Step 3 — Put it in `.env`

```bash
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="youraddress@gmail.com"
SMTP_PASS="abcdefghijklmnop"
MAIL_FROM="Strong XI <youraddress@gmail.com>"
```

Three things that trip people up:

- **`SMTP_USER` must be the full email address**, not just the part
  before the `@`
- **`MAIL_FROM` must use the same Gmail address.** Gmail rewrites or
  rejects a from-address it doesn't own, so a made-up
  `no-reply@yourdomain.com` will not work here
- **Port 587** is correct. The code switches to implicit TLS only when
  the port is 465, and 587 uses STARTTLS — both work, 587 is the safer
  default

On Render, add these same five under **Environment**, then redeploy.

---

## Step 4 — Test it

1. Start the backend: `npm run dev`
2. Register a new account in the app with a real email address you can
   check
3. The code should arrive within a few seconds

**Check the server log either way.** If SMTP isn't configured the code
is printed there with a warning, so you can still complete signup while
sorting out the credentials.

---

## Common errors

| What you see | Cause | Fix |
|---|---|---|
| `Invalid login: 535-5.7.8 Username and Password not accepted` | Using your normal Gmail password | Use the 16-character App Password |
| Same error, with the App Password | Spaces left in, or `SMTP_USER` isn't the full address | Strip spaces; use the full address |
| `Daily user sending quota exceeded` | Past ~500 emails in 24h | Wait 24h, or move to Brevo/Resend |
| Nothing arrives, no error | Landed in spam | Check the spam folder; see below |
| `Connection timeout` | Host blocks outbound port 587 | Try port 465 |

### If codes land in spam

Sending from a plain `@gmail.com` address is the reason — the domain
doesn't authenticate your app as a sender. Options:

- Tell users to check spam (the app's OTP screen already says this)
- Or move to **Brevo** (300/day free) with your own domain and set up
  SPF/DKIM, which fixes deliverability properly

Only the five environment variables change if you switch — no code
changes.

---

## Moving off Gmail later

When 500/day isn't enough:

| Provider | Free tier |
|---|---|
| **Brevo** | 300/day |
| **Resend** | 3,000/month |
| **Mailgun / SendGrid** | Trial credits, then paid |

Swap the same five variables and restart. Everything else — code
generation, expiry, rate limits — is provider-independent.
