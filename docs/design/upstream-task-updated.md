# Draft: asking Vikunja to change a task's `updated` with its relations

The text below is a draft issue for [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja). Edit it, file it, and
link the issue here. Delete this file once Vikunja does it, or says it won't.

---

## Change a task's `updated` when its labels, assignees, reactions or relations change

### The problem

A client that keeps tasks on the device can ask for what changed since its last look:
`GET /api/v2/tasks?filter=updated > '<time>'`. That only works if `updated` changes whenever the task as returned by
`GET /tasks/{id}` changes. On Vikunja 2.7.0 it changes when the task's own fields change, and when a comment is
added. It stays the same when:

- a label is added or removed (`PUT /tasks/{task}/labels/bulk`, `POST /tasks/{task}/labels`);
- an assignee is added or removed;
- a reaction is added or removed;
- a subtask is linked or unlinked, on either task;
- a subtask is marked done (the parent's `updated` stays, though its subtasks changed);
- the task's position in a view changes;
- an attachment is added.

So a client either misses those changes, or reads every task again to find them.

### The proposal

When one of the changes above is saved, set the `updated` of the task it belongs to, and for a relation, of both
tasks. Nothing else about the task changes, so a client that doesn't sync sees no difference.

If changing `updated` there is unwanted (it is shown as "last edited" in the web app), a second field such as
`changed_at`, filterable like `updated`, would do the same job.

### Questions for the maintainers

- Should a position change in one view count as a change to the task?
- Is there a way to list tasks deleted since a time? Today a client checks which of its ids still exist with
  `filter=id in ...`, which works, but costs a request per few hundred ids.
