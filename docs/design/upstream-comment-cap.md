# Draft: asking Vikunja to give each task its own 50 comments in a task list

The text below is a draft issue for [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja). Edit it, file it, and
link the issue here. Delete this file once Vikunja does it, or says it won't.

---

## A task list with `expand=comments` returns 50 comments in all, not 50 for each task

### The problem

A task read alone with `expand=comments` comes with its first 50 comments. A task list with `expand=comments` should
give each task the same. It gives the oldest 50 comments of all the tasks in the reply instead. The tasks whose
comments come later get some of them or none, and nothing in the reply says so.

To reproduce it on 2.7.1, make a project with four tasks and give each task 20 comments, in order. Then:

- `GET /api/v2/projects/{id}/tasks?expand=comments` returns 20, 20, 10 and 0 comments. The fourth task has
  `comments: null`, which reads as a task with no comments.
- `GET /api/v2/projects/{id}/tasks?expand=comment_count` returns `comment_count: 20` for each task.
- `GET /api/v2/tasks/{id}?expand=comments` returns 20 comments for each task.

`addCommentsToTasks` reads the comments of all the listed tasks in one query, with a limit of 50 for the whole query
([task_comments.go#L292-L310](https://github.com/go-vikunja/vikunja/blob/v2.7.1/pkg/models/task_comments.go#L292-L310),
called from [tasks.go#L798-L799](https://github.com/go-vikunja/vikunja/blob/v2.7.1/pkg/models/tasks.go#L798-L799)).
The same code is on `main`.

[Pocket for Vikunja](https://github.com/ssweber/pocket-for-vikunja) reads a project's finished tasks in one list to
show how each checklist went. The skip reasons are comments, so in a busy project Pocket showed wrong counts until it
started asking for `comment_count` too and reading the comments of each task that came up short.

### The proposal

Apply the limit to each task, so a task in a list gets the same first 50 comments as a task read alone. One query can
still do it, with `ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created)` kept to 50 or fewer, which Postgres,
MySQL 8 and SQLite 3.25 support. The API docs could then say that `expand=comments` gives at most 50 comments per
task, and that a task with more has a `comment_count` above 50 and the rest at `/tasks/{id}/comments`.
