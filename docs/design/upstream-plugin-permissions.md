# Draft: asking Vikunja to let a plugin route take both POST and PATCH from an API token

The text below is a draft issue for [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja). Edit it, file it, and
link the issue here. Delete this file once Vikunja does it, or says it won't.

---

## A plugin route with both POST and PATCH can't give POST to an API token

### The problem

Since [2a13400](https://github.com/go-vikunja/vikunja/commit/2a134005f57808be5a456294522b164b4564ffe8), Vikunja names
an API token's permission by the route's action. Outside `/api/v2`, PUT is `create`, DELETE is `delete`, and POST and
PATCH are both `update`. A route that takes both POST and PATCH gets one key for the two, PATCH keeps it, and POST
can't be given to any token. Vikunja logs this as an error at every start:

```
API token permission plugins.pocket_v2_*_update would cover both PATCH ... and POST ...;
POST /api/v1/plugins/pocket/v2/* is not available to API tokens
```

A plugin can't avoid it. Its routes are all under `/api/v1/plugins/<name>/`, so a plugin that passes requests on to
`/api/v2`, as [Pocket for Vikunja](https://github.com/ssweber/pocket-for-vikunja)'s relay does, always takes both
methods on one route. On 2.7.0, `/routes` listed four keys for that route (POST, `_patch`, `_put`, `_delete`). On
2.7.1 it lists three, with no POST.

### The proposal

When two methods of one route would get the same key, give each its own, for example by adding the method to the key.
Then every method a plugin route takes can be given to a token, and the start-up error goes away.
