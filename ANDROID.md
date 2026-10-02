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
