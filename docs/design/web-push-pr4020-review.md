# Vikunja's Web Push (PR #4020), checked against what Pocket needs

Read on 2026-10-05: the PR's diff (vichr-vita's `fix-web-push-notifications`, 5 commits, 42 files) and Tokra110's
rebase of it onto main (`Tokra110/vikunja`, branch `webpush-4020`, 3 more commits: OpenAPI and the generated client,
the frontend on the v2 client, and Yaegi symbols). Where they differ, it says so. Nothing has been posted.

Pocket would build only the phone side: a switch, subscribing and registering, and handling pushes in `sw.js`.

## The short version

It fits. A second web app on the same site can register its own service worker's subscription, with no origin or
scope check, and the payload has enough to open the right task. The gaps are about choice and delivery: every
notification Vikunja can push goes to every subscribed device (no "reminders only"), reminders aren't marked urgent,
and API-token sign-ins can't subscribe at all.

| What Pocket needs | Covered? | Where |
| --- | --- | --- |
| Register a subscription made by Pocket's own service worker (its own scope) | Yes | `PUT /api/v2/user/settings/web-push/subscriptions/{device_id}` takes `{endpoint, expiration_time, keys: {p256dh, auth}}` from any client with a session. No origin, scope or client check (`pkg/routes/api/v2/web_push.go`, `UpsertWebPushSubscription` in `pkg/notifications/webpush.go`). Pocket's worker gets its own endpoint, so no 409. |
| `device_id` that doesn't clash with Vikunja's web app | Yes, if Pocket keeps its own | Any UUID; unique per user and device. The web app keeps its own in `localStorage` under `vikunja-web-push-device-id`, which Pocket can see on the same site: reusing it would replace the web app's subscription with Pocket's. Pocket needs its own key. |
| Sign-in: sessions | Yes | The route needs a user session (`sid` in the JWT) that's still active. Pocket's shared session works. |
| Sign-in: API tokens | **No** | No session id → 403 "web push requires a user session" (`webPushSession`). Pocket's token sign-ins can't get push. |
| Signing out revokes it | Yes | Logout (`LogoutSession`; on the rebase, `DeleteSessionByID`), revoking a session, a password change and deleting the account delete the session's subscriptions. Session expiry doesn't, on purpose. Signing out of Vikunja revokes Pocket's only where they share the session (Android, same storage); an iPhone's home-screen Pocket has its own. Pocket must also `unsubscribe()` its own worker's subscription on sign-out: the web app's logout only touches its own registration. |
| Payload has the task id | Partly | `{title: "Vikunja", body, url: "/tasks/42", tag, notification_id?, test?}` (`WebPushMessage`). The id is only inside `url`. No field says what kind of notification it is. `notification_id` is set only for notifications stored in the bell; reminders (which pass their own delivery key) and the overdue summary don't get one. |
| Reminders go out by push | Yes | `task.reminder` from the existing minute cron, now also pushed (`task_reminder.go`; on the rebase, `sendDueReminders`). It reads `task_reminders.reminder`, so relative reminders work when that column is right. Steps whose `due_date` our plugin writes directly need Pocket's own fix to that column (Level 2 of `reminders-design.md`). Push goes out even when the person's reminder emails are off. |
| Who gets reminders | Unchanged | The task's assignees and creator who can still see it (`getTaskUsersForTasks`). |
| `Urgency: high` on reminders | **No** | `sendWebPush` sets TTL and Topic only, so Android may hold reminders until the phone wakes. `webpush-go` has `Urgency: webpush.UrgencyHigh`. |
| TTL | Yes | Reminders 2 hours, the overdue summary until the next day, everything else 24 hours. |
| After retries run out | Dropped | Retries back off from 30s, doubling to 15 minutes, honouring `Retry-After`, until the TTL is up; then the delivery is deleted (metric `expired`). 404 or 410 deletes the subscription; any other 4xx drops that delivery. The queue lasts across restarts. |
| iPhone: Declarative Web Push (iOS 18.4+) | No, not needed | Plain JSON, shown by the service worker. Works on iOS 16.4+ home-screen apps; Pocket has its own worker anyway. |
| iPhone: dropped subscriptions | Yes, by re-registering | The web app calls `reconcileWebPushSubscription` on every load (`ContentAuth.vue`): it `PUT`s the browser's subscription again, idempotently. Pocket can do the same. It needs an active session, so it fails after the session expires; the existing subscription still delivers. |
| The same phone with both apps | Two notifications | Each app's subscription is its own row, and each gets a delivery, with the same `tag`. On an iPhone they're separate apps, so two notifications. On Android both workers are on the same site: unclear whether the second replaces the first by tag. Also: the web app's `notificationclick` takes the first window on the site, `includeUncontrolled`, which can be an open Pocket window, and navigates it to Vikunja's task page. |
| Choosing what a device receives | **No** | One switch per device. Reminders, comments, assignments, mentions, deleted tasks, new projects, team invites, API token expiry and overdue summaries all go to every subscribed device. The overdue summary follows the existing overdue setting. A service worker can't quietly drop a push it doesn't want: iOS and Chrome expect each push to show a notification. |
| Config, and the plugin | No effect | Adds `webpush.enabled`, `webpush.publickey`, `webpush.privatekey` and `outgoingrequests.timeoutseconds`, plus `/info` → `web_push_enabled` and `web_push_public_key`. The rebase adds those three `webpush` keys and `ValidateWebPushConfig` to the Yaegi symbols for `config`; `pkg/notifications` isn't exposed to plugins. Pocket's plugin reads its own keys through viper, so nothing changes for it. |

## What Pocket would build on it

- Show the switch only when `/info` says `web_push_enabled`, and only for session sign-ins.
- Subscribe with `/info`'s `web_push_public_key`, and register under a `device_id` of Pocket's own (not the web app's
  key). Re-register on every open, as the web app does.
- `sw.js`: on `push`, show `{title, body}` with its `tag`; on a tap, read the task id from `url` (`/tasks/(\d+)`) and
  open `#/task/<id>` in a Pocket window.
- On sign-out, `DELETE` the device and `unsubscribe()`.

## Draft comment

A follow-up to ours saying we'd use this. Not posted.

> Thanks again for this. I've now read it against what my app needs (a second home-screen web app served from the same
> Vikunja, with its own service worker), and registering from it works as is, which is great. Three things that would
> help, if they fit the direction:
>
> - **Choosing what a device gets.** Right now every pushable notification goes to every subscribed device. Could a
>   device say which kinds it wants (even just "reminders only")? A service worker can't quietly drop a push it doesn't
>   want, so this has to happen on the server. Adding the notification's name (e.g. `task.reminder`) and a `task_id`
>   to the payload would also let a client open the right screen without parsing `url`.
> - **`Urgency: high` on task reminders.** Without it, Android can hold a reminder until the phone wakes up.
>   `webpush-go` takes it as `Urgency: webpush.UrgencyHigh` in the options.
> - **API tokens.** Subscribing needs a session, so people who sign in with an API token can't get push. Is that
>   deliberate? A subscription tied to the token, and removed with it, would cover them.
