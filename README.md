# bb-plugin-gitlab

GitLab issues and merge requests inside BB, with one-click agent dispatch.
Self-managed instances are first-class: every host `glab` is logged into is a
host this plugin can reach.

This is a fork of
[suiramdev/bb-plugin-gitlab](https://github.com/suiramdev/bb-plugin-gitlab)
that also acts on merge requests from BB — approve, merge, run and retry
pipelines, edit reviewers — and shows the conversation as a threaded timeline
with reply and resolve.

```sh
bb plugin install git:https://github.com/HundredBeans/bb-plugin-gitlab.git@main --yes
```

`@main` tracks the branch head. The fork has no release tags of its own yet,
so there is no version to pin.

BB clones the ref, installs production dependencies, and builds
`dist/server.js` + `dist/app.js` itself, so nothing has to be committed built.
`glab` on `PATH` is the only prerequisite.

An id carries one source, so switching between them (git ↔ a local checkout for
development) starts with `bb plugin remove gitlab`; the plugin's cache and
thread links survive it.

## What it does

- **Sidebar panel** (GitLab tanuki, full width): Issues and Merge requests tabs
  across every tracked project, one filter box that takes qualifiers —
  `is:open`, `is:draft`, `assignee:@me`, `author:dana`, `label:"needs triage"`,
  `project:gitlab.com/acme/web`, `no:assignee`, `no:label`, and on merge
  requests `reviewer:@me` and `no:reviewer` — plus plain text, completed from
  the loaded items and driven by the keyboard (↑/↓, Enter or Tab to accept,
  Escape to dismiss). A project picker beside the tabs edits the same
  `project:` token. The query persists in localStorage.
- **Issue detail**: markdown description, notes, comment box, state, assignee
  and label editing, plus "Send agent". Deep-linkable through the URL hash:
  `#/issues/<host>/<namespace/path>/<iid>`.
- **Merge-request detail**: source → target branch, labels, and per-file diffs
  rendered by the same syntax-highlighting engine as the rest of BB, following
  the host's code theme. Deep-linkable as
  `#/merge_requests/<host>/<namespace/path>/<iid>`. On top of that:
  - **Merge box** — approve or revoke your approval; the pipeline with its jobs
    by stage, "Run pipeline", "Retry failed", "Cancel", and per-job run
    (manual), retry, or cancel; merge with the squash and delete-branch
    options pre-filled from GitLab, behind a confirmation, or "Set to
    auto-merge" while a pipeline runs; "Rebase" when GitLab asks for one.
    GitLab's merge status is spelled out ("All threads must be resolved
    first"). Merge and approve send the commit you saw, so GitLab refuses if
    new commits arrived meanwhile. A job that is allowed to fail shows as a
    warning, not red.
  - **Reviewers and assignees** — editable, also in the thread side panel.
  - **Activity** — GitLab's discussions as one timeline: events ("approved",
    "added 1 commit") as single lines, comments as cards, and threads with
    their replies grouped under them. An inline thread shows the file, the
    line, and the code it is about, read from the commit it was written
    against. Reply to any comment or thread, resolve or reopen threads, and
    filter by All / Comments / Unresolved. Resolved threads start folded.
  - **Live status** — while a pipeline runs, while GitLab re-checks
    mergeability, and for a minute after any action, the view polls a cheap
    status read every 10 seconds (never while the page is hidden).
- **Thread side panel** ("Merge request" in a thread's right panel): the same
  merge-request view, single column, resolved to the thread's own merge
  request through its branch.
- **Send agent / Review with agent**: spawns a BB worker thread on the issue (or
  a review thread on the merge request) in the matching BB project. The item
  then shows a ⚡ pill linking to the thread.
- **Mentions**: `#` completes GitLab issues, `!` completes merge requests (`@`
  does both); the selected item's title, state, and description are attached as
  agent context at send time.
- **`bb gitlab` CLI**: `projects`, `issues [project]`, `mrs [project]`, `sync` —
  also discoverable by agents through the plugin-commands skill, alongside the
  bundled `gitlab` skill that teaches `glab` conventions.

## Auth and any GitLab domain

Uses the GitLab CLI, so the plugin reaches whatever instances `glab` reaches —
`gitlab.com`, a self-managed instance on any domain, or several at once. Every
host that appears as `Logged in to <host> as <user>` in `glab auth status` is
usable; if no host is authenticated the plugin reports needs-configuration. No
tokens are stored by the plugin.

```sh
glab auth login --hostname gitlab.example.dev
bb plugin reload gitlab
```

A host's own glab config describes how it is reached, and the plugin reads that
config instead of guessing, so these all work:

| Hosting | glab config on that host | What the plugin does |
| --- | --- | --- |
| Plain domain, any TLD | — | uses the hostname as-is |
| Served under a path, `https://example.com/gitlab/` | `subfolder: gitlab` | drops the subfolder from project paths |
| API on a non-default port | `api_host: example.com:8443` | maps the port-bearing remote back to the host |
| Git over SSH on another name | `ssh_host: ssh.example.com` | maps that remote to the same instance |
| Plain HTTP, private CA, mTLS, proxy | `api_protocol`, `ca_cert`, `client_cert`, `proxy` | nothing needed — glab applies them |
| Internationalized domain | — | normalized to punycode, matched case-insensitively |

Ports and schemes never appear in a project ref: `glab --hostname` takes a bare
hostname, and the ref keeps exactly the name glab knows. IPv6 literal hosts are
the one gap, because glab rejects them.

## Which projects are tracked

A project is addressed by its **host-qualified ref**:
`gitlab.example.dev/group/subgroup/app`. The host is the first segment; the rest
is the namespace path, which may have any number of segments.

- Every BB project whose git remote points at an authenticated GitLab host —
  including remotes that use that host's `ssh_host`, `api_host`, or subfolder
  form. That mapping is also how "Send agent" picks the BB project to spawn in.
  The remote comes from BB's own project record, so a checkout on an enrolled
  remote host resolves exactly like a local one. A remote on a GitLab host glab
  is not logged into is reported in `bb plugin logs gitlab`.
- Plus the `extraProjects` setting: a comma-separated list of refs, normalized
  for you — a scheme, mixed case, a port, a subfolder, or a trailing slash are
  all accepted, and a bare `group/app` uses `defaultHost`.
- `defaultProject`: where threads spawn for GitLab projects with no BB project.

```sh
bb plugin config gitlab set extraProjects "https://Code.Example.dev:8443/gitlab/group/app, other/app"
bb plugin config gitlab set defaultHost gitlab.example.dev
bb plugin reload gitlab
```

A background service refreshes the issue/MR cache every 5 minutes; the panel's
Refresh button (or `bb gitlab sync`) forces it. The cache holds open items plus
a page of recently closed and merged ones, and the panel filters that cache in
the browser, so `is:closed` or `is:merged` costs nothing. Detail views,
mutations, and mention resolution always go live through `glab api`.

## Development

```sh
npm install --include=dev   # once
npm run typecheck
npm test
bb plugin build             # dist/server.js + dist/app.js + dist/app.css
bb plugin reload gitlab
```

`bb plugin dev` watches and reloads on every save. Plugin logs:
`bb plugin logs gitlab -f`.
