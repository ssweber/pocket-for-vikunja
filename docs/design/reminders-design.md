# Reminders for Pocket — design

Alerts and reminders for tasks and workflow steps. Three levels, each built on the one before, so nothing is thrown
away by stopping early. **Suggested: build Level 1 now, use Pocket for a while, then decide on Level 2.** Level 3 waits
on how Vikunja's own Web Push PR (#4020) goes.

| Level | What you get | Size |
|---|---|---|
| 1. Alerts while open | A toast (plus vibration on Android) when a step countdown reaches zero, or a task's due time or a reminder passes while Pocket is on screen. Today regroups itself every minute. | ~30 lines in the app, nothing on the server |
| 2. + Setting reminders | 🔔 chip in quick add, a Reminders row in the task sheet, reminders on timed workflow steps. Vikunja emails them while Pocket is closed. | ~150–200 lines in the app, ~10 in the plugin |
| 3. + Push to the phone | The phone shows the reminder with Pocket closed, like a reminders app. | ~250 lines in the plugin, a table of its own, outbound connections, testing on real phones |

## What Pocket does today when something is due

Nothing pops up, sounds or vibrates.

- **Today** groups tasks into Overdue / Today / Next 7 days, and a due time that has passed shows in red. It's only
  recomputed when Pocket opens or comes back to the front (`visibilitychange`, in `init()` in `src/js/app/core.js`). Left open on
  Today, a 4pm task stays under Today until you leave and come back.
- **🔔 on a row** when a task has a reminder in Vikunja that's still to come (`rowMeta()` in `src/js/app/views.js`). Display only:
  Pocket can't set or edit reminders.
- **Run screen** is the one live place: countdowns tick every second (`clock`, set every second in `init()` in `src/js/app/core.js`), are pinned at the top, and
  turn "2m late" in red. Nothing happens at zero.
- **Vikunja** emails reminders set in its web app, if mail is set up.

## What Vikunja 2.7 provides

Checked in the v2.7.0 source.

- **Reminders on a task:** `reminders: [{reminder, relative_period, relative_to}]`. A fixed time, or an offset in
  seconds (negative = before) from `due_date`, `start_date` or `end_date`. Relative ones are recalculated when a task
  is saved through the API (`updateRelativeReminderDates`, `pkg/models/tasks.go`).
- **The reminder check runs every minute** (`pkg/models/task_reminder.go`, `RegisterReminderCron`), even without mail.
  For each reminder that comes due, it picks the task's **assignees and creator** who can still see the project, works
  out the time in each person's timezone, and then:
  - always stores an in-app notification `task.reminder` (`GET /notifications`, the bell in the web app);
  - emails it only if the mailer is on, `service.enableemailreminders` is on, and the person's
    `email_reminders_enabled` setting is on (default on for new users);
  - sends a `task.reminder.fired` event only if webhooks are enabled. People can point a personal webhook at it.
- **The daily overdue summary** goes by email only and isn't stored.
- **`/info` → `email_reminders_enabled`** reflects only the server config, not whether mail actually works.
- **No push of any kind** in 2.7. The web app checks its bell while open; nothing reaches a closed phone.
- **CalDAV** sends reminders as VALARMs, so a CalDAV tasks app rings on its own. Outside Pocket.

## What a PWA can do

| Option | Works? |
|---|---|
| Timers and notifications while the app is open | Yes, but nothing when it's closed |
| Scheduled local notifications (Notification Triggers / `showTrigger`) | No: Chrome ended development, never shipped |
| Periodic Background Sync | Chromium on Android only, ~12h or more apart. Useless for reminders |
| Web Push | Yes. The only way to ring a closed PWA, and it needs a server to send at the right time |
| Badge on the icon (`setAppBadge`) | Yes. Updated when the app runs or a push arrives |
| Vibration (`navigator.vibrate`) | Android only; iPhones don't support it from web apps |

---

## Level 1 — Alerts while open

- **Run screen:** when a countdown crosses zero, show a toast ("Check the oil temperature is due") and vibrate. The
  clock already ticks every second there; remember which steps have alerted so each alerts once.
- **Today:** a once-a-minute timer, while visible, redoes the grouping, so a task moves to Overdue as its time passes.
  A task that crosses its due time, or one of its `reminders`, while you're looking gets the same toast.
- **No server, no permissions.** It's an in-app toast, not a system notification. A system notification while open
  would need a permission prompt for little gain.
- **Doesn't** do anything while Pocket is closed or in the background.

## Level 2 — Setting reminders, delivered by Vikunja's email

1. **Reminders row in the task sheet.** Choose "At due", "15 min / 1 hour / 1 day before", or a set date and time.
   List and remove existing ones. A reminder is relative to `due_date` when the task has one, so it moves with it, and
   fixed when it doesn't. It saves like the other fields.
2. **🔔 chip in quick add.** Typing a time ("at 4pm", "in 2 hours") adds a **🔔 4:00 PM** chip next to the date chip.
   Tap to strike it out, like any chip. A date without a time ("friday", due at the default time) gets none.
   - Only shown if reminders can be delivered: `/info` `email_reminders_enabled` and the user's own setting is on.
   - **Open:** on or off by default? With email as the delivery, lean **off by default with a setting**, since an
     email for every timed task could feel like a lot. With Level 3, on by default makes sense.
3. **Timed workflow steps** get an "at due" reminder (`relative_to: due_date`, period 0) when a run starts.
   - **Plugin change (~10 lines):** `setStepDueDates` writes `due_date` directly, which skips Vikunja's relative
     reminder recalculation. In the same transaction, set `reminder = due + relative_period` on that step's
     `relative_to = due_date` reminders.
   - Only fires with step times on, since that's what gives steps due dates in Vikunja.
   - The email goes to the run's starter (the steps' creator) and anyone the step is assigned to. The person the run
     is *for* only gets it if they started it, because Pocket deliberately assigns only the run.
   - Fits steps hours apart ("check the dough T#4h"). For "in 10 minutes", the Level 1 countdown is what matters.
4. **README:** a Reminders section: what Pocket sets, that Vikunja delivers them by email, where the email reminder
   setting is, and that the server needs mail. On Cloudron, mail is set up for apps by default. Optionally mention
   the community webhook → ntfy route for phone alerts without email.

**Doesn't:** ring a phone that has no mail notifications, or work on a server without mail.

## Level 3 — Web Push from the plugin

Only if Level 2 isn't enough. Designed so Pocket switches to Vikunja's own push if #4020 is merged, and this part of
the plugin is then deleted.

**Plugin** (off by default, e.g. `plugins.pocket.push: true`, like step times)
- **Table `pocket_push`**, made by a plugin migration (`NewMigrationPlugin`): one row per phone (user, endpoint,
  p256dh, auth, created, last success). Also holds the VAPID key pair, generated on first start, so there's nothing
  to configure, and how far the plugin has read in `notifications`, so a restart doesn't miss or repeat.
  - Rejected: subscriptions in the user's `frontend_settings`, because the web app saves that whole object and could
    overwrite them. A file next to the plugin breaks where the folder is read-only, as in our dev setup.
  - Vikunja doesn't drop plugin tables on uninstall, so the README says how.
- **Authenticated routes:** get the public key, add or remove a phone, send a test.
- **Loop, about every 20s:** read new `task.reminder` rows from `notifications` and push each to that user's phones.
  Vikunja has already chosen who gets it and when, and this works without mail or webhooks. Retry a few times, then
  drop: there's no lasting queue, since a 20-minute-late reminder isn't worth much. Delete phones that answer 404/410.
  Pushing assigned, comment and mention notifications later is a one-line filter.
- **Encryption, no library:** VAPID (ES256 JWT) and RFC 8291 aes128gcm, about 90 lines. HKDF is written with `hmac`.
  Yaegi v0.16.1's stdlib symbols include `crypto/ecdh`, `ecdsa`, `aes`, `cipher` and `hmac` (checked); they run as
  compiled Go. `webpush-go` can't be imported by a Yaegi plugin.
- **`Urgency: high`** on every push, or Android's battery saving holds it until the phone wakes.
- **Declarative Web Push payload** for iOS 18.4 and later, so the notification shows without waking the service
  worker, with a service-worker fallback elsewhere.
- **Step aside** if Vikunja's own `webpush.enabled` is on, so nobody gets two notifications.

**App**
- **Settings:** "Notifications on this phone": permission on a tap, subscribe, a "Send a test" button. On an iPhone,
  only in the home-screen app; in Safari it says to add Pocket to the home screen first.
- **Re-register on every open,** since iPhones can drop subscriptions silently. When the plugin has deleted a dead
  one, show "Notifications stopped on this phone — tap to turn them on again".
- **`sw.js`:** `push` → show the notification, tagged with the task id; `notificationclick` → open `#/task/<id>`. No
  Done or Snooze buttons: iPhones don't support them, and the service worker can't read the sign-in in
  `localStorage`. About 40 → 70 lines.
- **Badge** the overdue count with `setAppBadge`.
- **Sign-out** removes the phone's subscription.

**Tests:** a Node test makes its own subscription keys and a fake push server, then decrypts what the plugin sends.
Plugin routes and the loop in `steptimes.mjs` style. Real phones by hand, on a real HTTPS server.

**What changes about the plugin:** it now keeps data of its own and connects to Google, Apple and Mozilla push
services, so a firewalled server breaks it. The README's trust story changes from "writes due dates if you turn it on"
to also "stores phone subscriptions and sends notifications". Payloads are encrypted for the phone, so push services
see only that a push was sent. Reading `notifications` is one more tie to Vikunja's internals. `main.go` goes from
~420 to ~670 lines.

### Reliability

| Step | How reliable |
|---|---|
| Vikunja notices the reminder is due | Solid; checked every minute |
| Plugin reads and sends it | Adds up to ~20s; our code, testable |
| Android: Google → Chrome | Good, usually seconds, with `Urgency: high`. Aggressive battery savers (some Samsung, Xiaomi) can still delay it if Chrome is restricted |
| iPhone: Apple → home-screen app | Works; the weak link. See below |

- iPhones sometimes drop a push subscription without the user doing anything: WebKit bug 273063, still open. Apple
  fixed some causes in iOS 17.5, but reports continue. iOS doesn't fire `pushsubscriptionchange`, so the app can't
  know. Re-registering on open and the "stopped" notice limit the damage.
- Every push must show a notification or iOS revokes push. Every reminder does, so that's fine.
- Focus modes can hide reminders.
- Bottom line: good for "nudge me at 4pm" or "the dough's been rising 4 hours". Not alarm-clock grade, especially on
  an iPhone that hasn't opened Pocket in a week. Not for steps where a miss is a safety problem; the README should
  say so.

### Open questions

- Do plugin routes accept API tokens? If not, people who sign in with a token can't turn notifications on.
- Should step reminders also go to the run's assignees? Vikunja sends them only to the steps' creator and assignees.

## Vikunja's own Web Push: PR #4020

- go-vikunja/vikunja#4020 (opened 2026-09-25, open, no reviews) continues #3463 (closed 2026-10-04 in its favour). On
  #3463 the maintainer wrote: "This is pretty big and I'm unsure about the direction, will take a moment until I get to
  properly review it." It could take months, or never land.
- What it adds: `webpush.enabled` plus VAPID keys in config (`vikunja webpush generate-keys`), tables
  `web_push_subscriptions` and `web_push_deliveries` with a lasting delivery queue, and pushes for reminders,
  overdue summaries, comments, assignments and mentions.
- Pocket's part if it lands: register the phone with `PUT /user/settings/web-push/subscriptions/{device_id}` and
  handle `{title, body, url, tag, notification_id}` in `sw.js`, rewriting the `url` to Pocket's
  `#/task/<id>`. A subscription is tied to a sign-in session, so API-token sign-ins can't use it.
- Levels 1 and 2 carry over unchanged.

## Sources

- Vikunja v2.7.0 source: `pkg/models/task_reminder.go`, `pkg/models/notifications.go`, `pkg/routes/api/shared/info.go`,
  `pkg/plugins/interfaces.go`, `pkg/plugins/yaegi/loader.go`
- https://github.com/go-vikunja/vikunja/pull/4020 and https://github.com/go-vikunja/vikunja/pull/3463
- https://web.dev/notification-triggers/ (development ended)
- https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ (Declarative Web Push)
- https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/ (home-screen apps stay in the EU)
- https://bugs.webkit.org/show_bug.cgi?id=273063 (iOS subscriptions dropped)
- https://developer.apple.com/forums/thread/728796 (iOS PWA push issues)
- https://firebase.google.com/docs/cloud-messaging/android-message-priority (priority and Doze)
- https://community.vikunja.io/t/my-reliable-setup-for-notifications-vikunja-node-red-ntfy/4336 (webhook → ntfy)
