# Cherub's OS

A private personal app for client sessions, weekly and monthly payments, notes, reminders, tasks, schedule and money.

- **App:** https://cherubpraison-ops.github.io/cherubs/
- **Data:** stored privately in Firebase (Firestore), locked to the signed-in account by `firestore.rules`. Nothing personal is stored in this repository.
- **Notifications:** `.github/workflows/notify.yml` runs `notifier/notify.js` every 15 minutes and sends push notifications (evening check-in, Sunday advances, month-end fees, reminders). It needs the `FIREBASE_SA` repository secret.
- **Offline:** `sw.js` keeps the app working without internet; changes sync when you're back online.
