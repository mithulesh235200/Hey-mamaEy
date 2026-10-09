# Android app

This repository includes a Capacitor Android project that packages the same React app in an Android WebView.

## Requirements

- Node.js 22 or newer
- Android Studio with the Android SDK and an emulator or connected device
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set in a local build environment

Only the Supabase publishable key belongs in the Android client build. Never add the service-role key to a client environment.

## Build and open

```sh
npm install
npm run android:sync
npm run android:open
```

`android:sync` creates the static app shell and copies it into the Android project. Android Studio can then run the app on an emulator or device. The first Android Gradle build downloads platform dependencies.

The Android manifest declares camera and microphone access for the existing voice and video call features. Android asks for those permissions when the call flow requests them.

The Android SDK is required to build an APK or run on a device; the web production build does not require it.

## One-time server setup (Storage + Push)

Run these two SQL files once in Supabase Dashboard > SQL editor:

- `supabase/migrations/20261009000000_space_media_storage.sql` — creates the public `space-media` bucket so photos/video/voice/files upload as URLs instead of base64 blobs.
- `supabase/migrations/20261009010000_push_tokens.sql` — creates the `push_tokens` table + RPCs for background notifications.

Until the storage SQL is applied, uploads keep working via the automatic base64 fallback.

## Push notifications (FCM)

1. Create a Firebase project at https://console.firebase.google.com, add an Android app with package `com.heymamaey.chat`, and download `google-services.json` into `android/app/`. (Without this file the app still builds; push just stays in-app only.)
2. In Firebase project settings > Service accounts, generate a key and save the JSON.
3. Deploy the fan-out function:
   ```sh
   supabase functions deploy push-on-message
   supabase secrets set SUPABASE_URL=https://your-project.supabase.co SUPABASE_SERVICE_ROLE_KEY=... FCM_PROJECT_ID=... FCM_SERVICE_ACCOUNT='{"type":"service_account",...}'
   ```
   (`FCM_SERVICE_ACCOUNT` is the full service-account JSON on one line.)
4. Dashboard > Database > Webhooks: create a trigger on `public.messages` INSERT that POSTs the row to your `push-on-message` function URL.
5. Rebuild: `npm run build:android && npx cap sync android`, then build the APK from Android Studio.
