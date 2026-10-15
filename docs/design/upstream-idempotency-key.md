# Draft: asking Vikunja to support Idempotency-Key

The text below is a draft issue for [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja). Edit it, file it, and
link the issue here. Delete this file once Vikunja supports the header, along with Pocket's relay.

---

## Support the `Idempotency-Key` header on `/api/v2` writes

### The problem

A client on a phone often loses the reply to a write. The request may or may not have reached Vikunja. Sending it again
is safe for some writes, such as `PUT /tasks/{task}/labels/bulk`, but not for others:

- `POST /projects/{project}/tasks` makes a second task.
- `POST /tasks/{task}/comments` posts the comment twice.
- `POST /tasks/{task}/duplicate` makes a second copy.
- `POST /tasks/{task}/attachments` uploads the file twice.
- Marking a repeating task done twice moves its due date on twice, so it skips a date.

So a client has to search afterwards for what its lost request may have made, by title, author and creation time. That
is slow, and it guesses wrong when two tasks have the same title.

### The proposal

Support the `Idempotency-Key` request header from the IETF httpapi working group's draft
([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/))
on `/api/v2`'s `POST`, `PUT`, `PATCH` and `DELETE` routes. A client that doesn't send the header sees no change.

When a request has the header, Vikunja stores the response under (user, key) and returns it again for a request with
the same key, without running the write again. As the draft describes:

- the same key while the first request is still running: `409 Conflict`;
- the same key with a different method, path or body: `422 Unprocessable Content`;
- the same key after the first request finished: the first response, whether it succeeded or failed.

Keys could be kept for a configurable time, such as 24 hours, and the expiry documented as the draft asks.

An expired key looks like a new one, so a client retrying late would make the duplicate the header exists to
prevent. A client can send a UUIDv7 key, which holds the time it was made. Vikunja could then refuse a key older than
it keeps keys, with `409 Conflict`, instead of running the write again. The client can then ask the user what to do.

If Vikunja stores the key in the same transaction as the write, a request either happened, with its key stored, or
didn't happen at all. A client then never has to guess.

### A working example

[Pocket for Vikunja](https://github.com/ssweber/pocket-for-vikunja) is building this in its plugin, as a relay in front
of `/api/v2`: [`pocket/relay.go`](https://github.com/ssweber/pocket-for-vikunja/blob/spike/relay/pocket/relay.go), not yet released. Pocket would
delete the relay and send to `/api/v2` directly once Vikunja supports the header. Because the relay runs outside
Vikunja's transaction, it has a small gap that native support wouldn't: if Vikunja stops between committing the write
and storing the answer, a retry can't tell whether the write happened.

### Questions for the maintainers

- Where should the keys live: a table, or Vikunja's key-value store?
- Should every `/api/v2` write accept the header, or only the creates and the writes with side effects?
- How long should keys be kept, and should that be a setting?
