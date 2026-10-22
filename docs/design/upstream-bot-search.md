# Draft: asking Vikunja to list a user's own bots only on projects the bots can see

The text below is a draft issue for [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja). Edit it, file it, and
link the issue here. Delete this file once Vikunja does it, or says it won't. Pocket's check of each own bot's shares
(`botSees` in `src/js/app/quickadd.js`) can go once Vikunja does it.

---

## A project's user search lists your own bots on every project, even ones they can't see

### The problem

`GET /api/v2/projects/{id}/users/search` should list the users who can see the project, so a client can offer them as
assignees. It also lists every bot the caller owns, on every project the caller can read, whether or not the bot has
access. Assigning such a bot then fails with 403 and code 7003, "This user does not have access to the project".

To reproduce it on 2.7.1, as a user with a private project (no shares), and a second project:

1. `POST /api/v2/user/bots` with `{"username": "bot-helper"}`.
2. Share the second project with `bot-helper`.
3. `GET /api/v2/projects/{private}/users/search` lists you and `bot-helper`.
4. `GET /api/v2/projects/{private}/users` lists no one, because the project has no shares.
5. `POST /api/v2/tasks/{task in the private project}/assignees` with the bot's id answers 403, code 7003.

`ListUsersFromProject` passes the ids of the users with access as `AdditionalCond`
([user_project.go#L198-L227](https://github.com/go-vikunja/vikunja/blob/v2.7.1/pkg/models/user_project.go#L198-L227)).
`ListUsers` ANDs that condition with the search conditions, and then ORs the result with `ownBotCond`, which has no
access condition
([users_project.go#L128-L203](https://github.com/go-vikunja/vikunja/blob/v2.7.1/pkg/user/users_project.go#L128-L203)).
The comment there says own bots should skip the `discoverable_by_name` check. Skipping the project's access check
looks like a side effect. The same code is on `main`.

[Pocket for Vikunja](https://github.com/ssweber/pocket-for-vikunja) uses this search to suggest assignees and to tell
whether a project is shared with anyone. So it offered the bot on the user's private Inbox, and showed a "+ me" button
there as if someone else could take the task. Pocket now reads `/projects/{id}/users` for each project and its parents
whenever the search lists one of the user's own bots. That misses a bot that sees a project only through a team.

### The proposal

Apply `AdditionalCond` to the whole condition, own bots included:

```go
where := builder.Or(builder.And(cond, notSomeoneElsesBot), ownBotCond)
if opts.AdditionalCond != nil {
	where = builder.And(where, opts.AdditionalCond)
}
err = s.Where(where).OrderBy("id").Find(&users)
```

The global user search (`SearchUsers`) passes no `AdditionalCond`, so it would still find your own bots without
`discoverable_by_name`. Only the per-project search changes.
