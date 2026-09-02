# MailFlow — Setup

Follow these in order. Steps 1–2 are one-time machine setup; steps 3–4 are the Google
side, and nothing will work until they are done.

---

## 1. Install Android Studio

Your machine currently has no Android SDK, no Gradle, and only Java 8 (Android needs 17).
Android Studio bundles all three, so it is the only install you need.

- Download: https://developer.android.com/studio
- During the setup wizard accept the default SDK install, and make sure
  **Android SDK Platform 35** and **Android SDK Build-Tools** are checked.

Verify afterwards: Android Studio → **More Actions → SDK Manager** should list API 35.

## 2. Open the project

1. Android Studio → **Open** → pick this folder (`automation gmail`).
2. It will say the Gradle wrapper is missing and offer to generate/use its own Gradle —
   accept. Then let it sync; the first sync downloads dependencies and takes a few minutes.

> **Move the project off OneDrive.** Gradle writes thousands of small files into `build/`
> and OneDrive's sync engine locks them mid-build, which produces random, confusing
> failures. Copy the folder to something like `C:\dev\mailflow` and open it from there.

## 3. Get your app's SHA-1 fingerprint

Google identifies an Android OAuth client by **package name + signing fingerprint**, so
you need the debug keystore's SHA-1.

In Android Studio: open the **Gradle** panel (right edge) → `MailFlow → Tasks → android →
signingReport` → double-click. Copy the `SHA1:` value from the `debug` variant.

Or from a terminal:

```bash
keytool -list -v -keystore "$USERPROFILE/.android/debug.keystore" -alias androiddebugkey -storepass android -keypass android
```

## 4. Configure Google Cloud

Go to https://console.cloud.google.com/ and sign in as **kirtichadda461@gmail.com**.

**a. Create a project** — top bar project picker → **New Project** → name it `MailFlow`.

**b. Enable the Gmail API** — *APIs & Services → Library* → search "Gmail API" → **Enable**.

**c. Configure the OAuth consent screen** — *APIs & Services → OAuth consent screen*:
- User type: **External**
- App name: `MailFlow`, support email + developer email: your address
- **Scopes** → *Add or remove scopes* → add
  `https://www.googleapis.com/auth/gmail.modify`
- **Test users** → *Add users* → add `kirtichadda461@gmail.com`
- Leave the app in **Testing**. Do not click "Publish app".

**d. Create the OAuth client** — *APIs & Services → Credentials → Create Credentials →
OAuth client ID*:
- Application type: **Android**
- Name: `MailFlow Android`
- Package name: `com.kirti.mailflow`
- SHA-1: paste the fingerprint from step 3
- **Create**

There is no file to download. Android OAuth clients carry no secret — the package name
and fingerprint are the credential, which is why step 3 has to match exactly.

## 5. Run it

Plug in a phone with USB debugging on, or use an emulator image that includes the
**Google Play Store** (a plain AOSP emulator has no Play Services and authorization will
fail). Press **Run ▶**.

On first launch you will see:
1. A notification permission prompt (Android 13+).
2. Google's account picker, then a consent screen listing Gmail access.
3. Your inbox.

---

## About the `gmail.modify` scope

`gmail.modify` is one of Google's **restricted** scopes. That is fine for personal use:
an app in *Testing* mode works normally for the test users you listed. The consent screen
will show an "unverified app" warning — click **Advanced → Go to MailFlow (unsafe)**.
That warning exists because *you* are the unverified developer; it is your own app.

If you ever wanted to ship this to other people on the Play Store, Google would require a
verification review including a security assessment. Not needed for your own inbox.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `10: DEVELOPER_ERROR` on connect | SHA-1 or package name in the Cloud console doesn't match. Re-run `signingReport`. |
| `403` banner in the app | Gmail API not enabled, or your address isn't listed as a test user. |
| `401` / "Session expired" | Access token aged out. Tap refresh; it renews silently. |
| Consent screen never appears | Emulator has no Play Services. Use a Play Store system image. |
| Random Gradle file-lock errors | The project is inside OneDrive. Move it (see step 2). |
| No new-mail notifications | Battery optimization is pausing WorkManager. Settings → Apps → MailFlow → Battery → **Unrestricted**. |
