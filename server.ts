// bb-plugin-gitlab — GitLab issues & merge requests inside BB.
//
// Auth rides on the GitLab CLI: every host `glab auth status` reports as
// logged in is a host this plugin can reach, so self-managed instances work
// without extra configuration. Projects are discovered from each BB project's
// git remote (kept when its host is one of those authenticated hosts) plus an
// optional extraProjects setting. A background service syncs open +
// recently-closed issues/MRs into the plugin's SQLite cache; the frontend
// panel and mention providers read that cache, while mutations (note, create,
// close/reopen, assign, label) and detail views go straight through
// `glab api`.
//
// A project is addressed by its host-qualified ref — "gitlab.com/group/sub/app"
// — because a GitLab path has any number of namespace segments and the same
// path can exist on two instances.
import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = 5 * 60_000;
const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const MR_PAGE = 50;
const CLOSED_MR_PAGE = 30;
/** One page of per-file diffs; a bigger merge request reports truncation. */
const DIFF_PAGE = 100;
/** Per-file diffs above this size stay on GitLab; the panel links out. */
const MAX_PATCH_BYTES = 20_000;
/** Discussion pages (100 each) read for one merge request's timeline. */
const DISCUSSION_PAGES = 10;
/** Files above this size are not fetched just to show a thread's lines. */
const MAX_SNIPPET_FILE_BYTES = 1_000_000;
/** Lines of code shown around an inline thread's own line(s). */
const SNIPPET_CONTEXT_BEFORE = 3;
const SNIPPET_CONTEXT_AFTER = 2;
const MAX_SNIPPET_LINES = 40;

const GLAB_HINT =
  "Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run " +
  "`glab auth login`, then `bb plugin reload gitlab`.";

/**
 * "host/group/sub/project" — the host glab knows the instance by, then a path
 * of 1+ namespace segments. No port and no scheme: `glab --hostname` accepts a
 * bare hostname only, and everything else about how an instance is reached
 * (port, subfolder, http, alternate SSH host, custom CA) lives in that host's
 * glab config. Underscores appear in intranet hostnames, which glab accepts.
 */
const PROJECT_REF_PATTERN =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// ---------------------------------------------------------------------------
// The rpc contract: what the frontend panel may ask for.
// ---------------------------------------------------------------------------
const projectRefSchema = z.string().regex(PROJECT_REF_PATTERN);
const iidSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ project: projectRefSchema, iid: iidSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
/** A commit sha. Guards merge and approve against a head that moved. */
const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
/** GitLab discussion ids are hex digests; they go into a URL path segment. */
const discussionIdSchema = z.string().regex(/^[0-9a-f]{8,64}$/);
/** A numeric pipeline or job id. */
const gitlabIdSchema = z.number().int().positive();
const repoPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/"), "must be repository-relative");
const projectInfoSchema = z
  .object({
    project: projectRefSchema,
    host: z.string().min(1),
    path: z.string().min(1),
    bbProjectId: z.string().nullable(),
  })
  .strict();
const itemSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    kind: z.enum(["issue", "mr"]),
    title: z.string(),
    /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    /** Empty for every issue — GitLab has no reviewers on one. */
    reviewers: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const noteSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "mr"]),
    project: projectRefSchema,
    iid: iidSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
/** One note inside a timeline entry. System notes are GitLab's own events. */
const timelineNoteSchema = z
  .object({
    id: z.number().int().nonnegative(),
    author: z.string(),
    body: z.string(),
    createdAt: z.string(),
    system: z.boolean(),
  })
  .strict();
/**
 * Where an inline thread sits. `side` is the side of the diff the line is
 * on: "old" only for a removed line, whose text lives in the base commit.
 * `ref` is the commit holding that copy of the file. Line fields are null for
 * a comment on a whole file or an image.
 */
const diffPositionSchema = z
  .object({
    path: z.string(),
    side: z.enum(["new", "old"]),
    line: z.number().int().positive().nullable(),
    /** Last line of a multi-line comment; equals `line` for one line. */
    endLine: z.number().int().positive().nullable(),
    ref: z.string().nullable(),
  })
  .strict();
/**
 * One row of the merge request's activity, in GitLab's order.
 *
 * - `event` — a system note: "approved this merge request", "added 1 commit".
 * - `comment` — a single comment with no replies.
 * - `thread` — a discussion: a comment on a diff line, or any comment that
 *   has replies. Replies and resolve address it by `id`.
 */
const timelineEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["event", "comment", "thread"]),
    resolvable: z.boolean(),
    resolved: z.boolean(),
    resolvedBy: z.string().nullable(),
    position: diffPositionSchema.nullable(),
    notes: z.array(timelineNoteSchema),
  })
  .strict();
const pipelineSchema = z
  .object({
    id: z.number().int().positive(),
    status: z.string(),
    url: z.string(),
  })
  .strict();
const jobSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    stage: z.string(),
    /** "warning" is a failed job the pipeline is allowed to ignore. */
    status: z.enum(["success", "failure", "warning", "pending", "neutral"]),
    /** GitLab's own word: "manual", "failed", "canceled", "running", … */
    rawStatus: z.string(),
    url: z.string(),
  })
  .strict();
/** The parts of a merge request that move while it is open. */
const mergeRequestStatusSchema = z
  .object({
    state: z.string(),
    draft: z.boolean(),
    sha: z.string(),
    /** GitLab's detailed_merge_status, e.g. "mergeable", "need_rebase". */
    mergeStatus: z.string(),
    hasConflicts: z.boolean(),
    /** True while "merge when the pipeline succeeds" is set. */
    autoMerge: z.boolean(),
    pipeline: pipelineSchema.nullable(),
    jobs: z.array(jobSchema),
    /**
     * Changes whenever the conversation or the merge request itself does —
     * see activityKey — so a status poll can tell the panel to reload.
     */
    activityKey: z.string(),
  })
  .strict();
const mergeRequestSchema = mergeRequestStatusSchema
  .extend({
    project: projectRefSchema,
    iid: iidSchema,
    title: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    /** Summed over the diffs actually fetched — see filesTruncated. */
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** GitLab's own total, which can exceed files.length. */
    changedFiles: z.number().int().nonnegative(),
    /** True when the diff list stopped at the page limit, so files is partial. */
    filesTruncated: z.boolean(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewers: z.array(z.string()),
    approvalsRequired: z.number().int().nonnegative(),
    approvalsLeft: z.number().int().nonnegative(),
    approvedBy: z.array(z.string()),
    userHasApproved: z.boolean(),
    userCanApprove: z.boolean(),
    /** GitLab's own answer to "may the viewer merge this?". */
    canMerge: z.boolean(),
    /** Merge defaults, as GitLab's own merge widget would pre-fill them. */
    squash: z.boolean(),
    /** "always" and "never" lock the squash choice for the project. */
    squashOption: z.enum(["always", "never", "default_on", "default_off"]),
    removeSourceBranch: z.boolean(),
    /** The last merge attempt's error, when GitLab kept one. */
    mergeError: z.string().nullable(),
    blockingDiscussionsResolved: z.boolean(),
    timeline: z.array(timelineEntrySchema),
    /** Set when the discussions could not be read; the timeline is empty. */
    timelineError: z.string().nullable(),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const gitlabRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        glabOk: z.boolean(),
        glabError: z.string().nullable(),
        hosts: z.array(z.string()),
        projects: z.array(projectInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "mr"]).optional(),
        project: projectRefSchema.optional(),
        state: z.enum(["open", "closed"]).optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ username: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  projectLabels: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({ assignees: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            project: projectRefSchema,
            iid: iidSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            notes: z.array(noteSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getMergeRequest: {
    input: itemInputSchema,
    output: z.object({ mergeRequest: mergeRequestSchema }).strict(),
  },
  getMergeRequestStatus: {
    input: itemInputSchema,
    output: mergeRequestStatusSchema,
  },
  setApproval: {
    input: itemInputSchema
      .extend({ approved: z.boolean(), sha: shaSchema })
      .strict(),
    output: okResultSchema,
  },
  mergeMergeRequest: {
    input: itemInputSchema
      .extend({
        sha: shaSchema,
        squash: z.boolean(),
        removeSourceBranch: z.boolean(),
        autoMerge: z.boolean(),
      })
      .strict(),
    output: z.object({ state: z.string(), autoMerge: z.boolean() }).strict(),
  },
  cancelAutoMerge: { input: itemInputSchema, output: okResultSchema },
  rebaseMergeRequest: { input: itemInputSchema, output: okResultSchema },
  setMergeRequestPeople: {
    input: itemInputSchema
      .extend({
        reviewers: z.array(z.string().min(1)).optional(),
        assignees: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        reviewers: z.array(z.string().min(1)),
        assignees: z.array(z.string().min(1)),
      })
      .strict(),
  },
  runPipeline: { input: itemInputSchema, output: okResultSchema },
  pipelineAction: {
    input: z
      .object({
        project: projectRefSchema,
        pipelineId: gitlabIdSchema,
        action: z.enum(["retry", "cancel"]),
      })
      .strict(),
    output: okResultSchema,
  },
  jobAction: {
    input: z
      .object({
        project: projectRefSchema,
        jobId: gitlabIdSchema,
        action: z.enum(["play", "retry", "cancel"]),
      })
      .strict(),
    output: okResultSchema,
  },
  replyToDiscussion: {
    input: itemInputSchema
      .extend({ discussionId: discussionIdSchema, body: nonBlankStringSchema })
      .strict(),
    output: okResultSchema,
  },
  setDiscussionResolved: {
    input: itemInputSchema
      .extend({ discussionId: discussionIdSchema, resolved: z.boolean() })
      .strict(),
    output: okResultSchema,
  },
  getDiffSnippet: {
    input: z
      .object({
        project: projectRefSchema,
        ref: shaSchema,
        path: repoPathSchema,
        line: z.number().int().positive(),
        endLine: z.number().int().positive(),
      })
      .strict(),
    output: z
      .object({
        startLine: z.number().int().positive(),
        lines: z.array(z.string()),
      })
      .strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  commentMergeRequest: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        project: projectRefSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ iid: iidSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  mergeRequestForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ mergeRequest: itemInputSchema.nullable() }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

// ---------------------------------------------------------------------------
// GitLab REST payloads. These come off the network, so every field is parsed
// with a fallback: one odd row must never take down a list or a detail view.
// ---------------------------------------------------------------------------
const gitlabUserRowSchema = z.looseObject({
  id: z.number().int().catch(0),
  username: z.string().catch(""),
});
const gitlabItemRowSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string().catch(""),
  state: z.string().catch("opened"),
  draft: z.boolean().catch(false),
  work_in_progress: z.boolean().catch(false),
  author: gitlabUserRowSchema.nullish().catch(null),
  labels: z.array(z.string()).catch([]),
  assignees: z.array(gitlabUserRowSchema).catch([]),
  // Merge requests only; GitLab omits it on an issue, which `.catch` reads as
  // the empty list.
  reviewers: z.array(gitlabUserRowSchema).catch([]),
  web_url: z.string().catch(""),
  description: z.string().catch(""),
  updated_at: z.string().catch(""),
});
const gitlabItemListSchema = z
  .array(gitlabItemRowSchema.nullable().catch(null))
  .catch([]);
const gitlabMergeRequestRowSchema = gitlabItemRowSchema.extend({
  created_at: z.string().catch(""),
  source_branch: z.string().catch(""),
  target_branch: z.string().catch(""),
  changes_count: z.union([z.string(), z.number()]).catch(""),
  has_conflicts: z.boolean().catch(false),
  detailed_merge_status: z.string().catch(""),
  merge_status: z.string().catch(""),
  sha: z.string().catch(""),
  squash: z.boolean().catch(false),
  // Null when the author never chose; the project default applies then.
  force_remove_source_branch: z.boolean().nullable().catch(null),
  merge_when_pipeline_succeeds: z.boolean().catch(false),
  merge_error: z.string().nullable().catch(null),
  blocking_discussions_resolved: z.boolean().catch(true),
  user: z
    .looseObject({ can_merge: z.boolean().catch(false) })
    .nullish()
    .catch(null),
  head_pipeline: z
    .looseObject({
      id: z.number().int().nullable().catch(null),
      status: z.string().catch(""),
      web_url: z.string().catch(""),
    })
    .nullish()
    .catch(null),
});
const gitlabLineSchema = z
  .looseObject({
    new_line: z.number().int().nullable().catch(null),
    old_line: z.number().int().nullable().catch(null),
  })
  .nullish()
  .catch(null);
const gitlabNoteRowSchema = z.looseObject({
  id: z.number().int().nonnegative().catch(0),
  body: z.string().catch(""),
  system: z.boolean().catch(false),
  created_at: z.string().catch(""),
  resolvable: z.boolean().catch(false),
  resolved: z.boolean().catch(false),
  resolved_by: gitlabUserRowSchema.nullish().catch(null),
  author: gitlabUserRowSchema.nullish().catch(null),
  position: z
    .looseObject({
      new_path: z.string().nullable().catch(null),
      old_path: z.string().nullable().catch(null),
      new_line: z.number().int().nullable().catch(null),
      old_line: z.number().int().nullable().catch(null),
      head_sha: z.string().nullable().catch(null),
      base_sha: z.string().nullable().catch(null),
      line_range: z
        .looseObject({ start: gitlabLineSchema, end: gitlabLineSchema })
        .nullish()
        .catch(null),
    })
    .nullish()
    .catch(null),
});
const gitlabNoteListSchema = z.array(gitlabNoteRowSchema).catch([]);
const gitlabDiscussionListSchema = z
  .array(
    z.looseObject({
      id: z.string().catch(""),
      individual_note: z.boolean().catch(false),
      notes: gitlabNoteListSchema,
    }),
  )
  .catch([]);
const gitlabDiffListSchema = z
  .array(
    z.looseObject({
      old_path: z.string().catch(""),
      new_path: z.string().catch(""),
      new_file: z.boolean().catch(false),
      deleted_file: z.boolean().catch(false),
      renamed_file: z.boolean().catch(false),
      diff: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabJobListSchema = z
  .array(
    z.looseObject({
      id: z.number().int().catch(0),
      name: z.string().catch("job"),
      stage: z.string().catch(""),
      status: z.string().catch(""),
      allow_failure: z.boolean().catch(false),
      web_url: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabApprovalsSchema = z
  .looseObject({
    approvals_required: z.number().int().nonnegative().catch(0),
    approvals_left: z.number().int().nonnegative().catch(0),
    user_has_approved: z.boolean().catch(false),
    user_can_approve: z.boolean().catch(false),
    approved_by: z
      .array(z.looseObject({ user: gitlabUserRowSchema.nullish().catch(null) }))
      .catch([]),
  })
  .catch({
    approvals_required: 0,
    approvals_left: 0,
    user_has_approved: false,
    user_can_approve: false,
    approved_by: [],
  });
const gitlabProjectSettingsSchema = z
  .looseObject({
    squash_option: z
      .enum(["always", "never", "default_on", "default_off"])
      .catch("default_off"),
    remove_source_branch_after_merge: z.boolean().catch(false),
  })
  .catch({ squash_option: "default_off", remove_source_branch_after_merge: false });
/** Just enough of a note to tell whether anything changed since. */
const gitlabNoteStampListSchema = z
  .array(
    z.looseObject({
      id: z.number().int().catch(0),
      updated_at: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabRepositoryFileSchema = z.looseObject({
  size: z.number().int().nonnegative().catch(0),
  encoding: z.string().catch("base64"),
  content: z.string().catch(""),
});
const gitlabMemberListSchema = z.array(gitlabUserRowSchema).catch([]);
const gitlabLabelListSchema = z
  .array(z.looseObject({ name: z.string().catch("") }))
  .catch([]);

type GitlabUserRow = z.infer<typeof gitlabUserRowSchema>;
type GitlabItemRow = z.infer<typeof gitlabItemRowSchema>;

interface ProjectInfo {
  /** "host/group/sub/project" */
  project: string;
  host: string;
  path: string;
  /** The BB project whose remote points at it, when there is one. */
  bbProjectId: string | null;
}

interface CachedItem {
  project: string;
  iid: number;
  kind: "issue" | "mr";
  title: string;
  state: string;
  draft: boolean;
  author: string;
  labels: string[];
  assignees: string[];
  /** Empty for every issue — GitLab has no reviewers on one. */
  reviewers: string[];
  url: string;
  body: string;
  updatedAt: string;
}

interface Note {
  author: string;
  body: string;
  createdAt: string;
}

interface ThreadLink {
  kind: "issue" | "mr";
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
}

/**
 * Runs `glab api` against the host a project ref names, returning raw JSON
 * (null for an empty response). `json` sends a JSON body instead of fields:
 * the only way to send a real boolean or an empty id list.
 */
type GitlabApi = (
  project: string,
  endpoint: string,
  options?: {
    method?: "POST" | "PUT";
    fields?: Record<string, string>;
    json?: Record<string, unknown>;
  },
) => Promise<unknown>;

type TimelineEntry = z.infer<typeof timelineEntrySchema>;
type DiffPosition = z.infer<typeof diffPositionSchema>;
type GitlabNotePosition = z.infer<typeof gitlabNoteRowSchema>["position"];

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

/**
 * One GitLab instance as glab knows it. `host` is the name `glab --hostname`
 * takes and `glab auth status` prints; the rest is that host's glab config,
 * which is where non-default hosting is described:
 *
 * - `subfolder` — GitLab served under a path, https://example.com/gitlab/
 * - `sshHost`   — git over SSH answers on another name than the API
 * - `apiHost`   — the API answers on another name, possibly with a port
 *
 * glab applies all of it; this plugin only has to recognize the remotes those
 * setups produce and map them back to `host`.
 */
export interface GitlabHost {
  host: string;
  subfolder: string;
  sshHost: string | null;
  apiHost: string | null;
}

/**
 * A comparable hostname: lowercased, punycoded, port and brackets removed.
 * Null for anything that cannot be a `--hostname` (an IPv6 literal, which
 * glab rejects outright, or a value the URL parser refuses).
 */
export function normalizeHostname(value: string): string | null {
  const bare = value.trim().replace(/\/+$/, "");
  if (bare.length === 0 || bare.startsWith("[")) return null;
  try {
    const { hostname } = new URL(`https://${bare}`);
    // IDN arrives as punycode here, which is what DNS and glab both want.
    return hostname.startsWith("[") || hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * "host/path" from any git remote URL that belongs to one of the instances
 * glab is authenticated with, else null. Handles https, scp-style
 * `git@host:group/app.git`, and `ssh://git@host:2222/group/app.git`, and
 * resolves the three ways a remote's host can differ from the glab host name:
 * an `ssh_host`, an `api_host` (with or without a port), and a `subfolder`
 * that is part of the URL but not part of the project path.
 */
export function parseGitlabRemote(
  url: string,
  knownHosts: readonly GitlabHost[],
): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const withScheme = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/i,
  );
  const scpStyle = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  const match = withScheme ?? scpStyle;
  if (match === null) return null;
  const remoteHost = normalizeHostname(match[1]);
  if (remoteHost === null) return null;
  const known = knownHosts.find((candidate) =>
    [candidate.host, candidate.sshHost, candidate.apiHost].some(
      (name) => name != null && normalizeHostname(name) === remoteHost,
    ),
  );
  if (known === undefined) return null;
  const remotePath = match[2].replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // A subfolder is part of the URL but not part of the project path.
  const prefix = known.subfolder.replace(/^\/+|\/+$/g, "");
  const path =
    prefix.length > 0 && remotePath.startsWith(`${prefix}/`)
      ? remotePath.slice(prefix.length + 1)
      : remotePath;
  if (!path.includes("/")) return null;
  const ref = `${normalizeHostname(known.host) ?? known.host}/${path}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/**
 * A user-written project entry ("HTTPS://Example.COM:8443/gitlab/group/app",
 * "group/app") as a project ref, or null when it cannot be one. Bare paths
 * take `fallbackHost`.
 */
export function normalizeProjectRef(
  entry: string,
  knownHosts: readonly GitlabHost[],
  fallbackHost: string,
): string | null {
  const trimmed = entry.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const asRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const viaKnownHost = parseGitlabRemote(asRemote, knownHosts);
  if (viaKnownHost !== null) return viaKnownHost;
  // An entry for an instance glab does not know yet: keep it addressable, so
  // logging in later starts tracking it instead of silently dropping it.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = withoutScheme.split("/").filter((part) => part.length > 0);
  const [first, ...rest] = segments;
  if (first === undefined) return null;
  const host = normalizeHostname(first);
  const looksHostQualified = host !== null && rest.length >= 2;
  const ref = looksHostQualified
    ? `${host}/${rest.join("/")}`
    : `${normalizeHostname(fallbackHost) ?? ""}/${segments.join("/")}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/** Splits a project ref into its host and its namespace path. */
export function parseProjectRef(ref: string): { host: string; path: string } {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`malformed GitLab project ref "${ref}"`);
  }
  return { host: ref.slice(0, separator), path: ref.slice(separator + 1) };
}

export function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && PROJECT_REF_PATTERN.test(value);
}

/**
 * Hosts `glab auth status` reports as logged in (stdout+stderr combined).
 * Whatever name glab prints is the name `--hostname` expects back, so it is
 * only case/IDN-normalized here, never rewritten.
 */
export function parseAuthenticatedHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/Logged in to (\S+) as /);
    if (match === null) continue;
    const host = normalizeHostname(match[1]);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

/**
 * +/- line counts of a unified diff. GitLab ships the diff text per file but
 * no per-file counts, so the panel's numbers come from here.
 */
export function countDiffLines(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** GitLab job status → one traffic-light value for the panel. */
export function classifyJobStatus(
  rawStatus: string,
): "success" | "failure" | "pending" | "neutral" {
  switch (rawStatus) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
      return "pending";
    default:
      // canceled, skipped, manual, and anything GitLab adds later.
      return "neutral";
  }
}

/**
 * A job's traffic light, where a failure the pipeline is allowed to ignore
 * is a warning: GitLab still calls that pipeline "success".
 */
export function classifyJob(
  rawStatus: string,
  allowFailure: boolean,
): "success" | "failure" | "warning" | "pending" | "neutral" {
  const status = classifyJobStatus(rawStatus);
  return status === "failure" && allowFailure ? "warning" : status;
}

/**
 * Where an inline thread points. A removed line exists only on the old side,
 * so its text is read from the base commit; every other line from the head.
 * A multi-line comment keeps its range when both ends are on the same side.
 */
export function toDiffPosition(
  position: GitlabNotePosition,
): DiffPosition | null {
  if (position == null) return null;
  const side =
    position.new_line == null && position.old_line != null ? "old" : "new";
  const path =
    (side === "old" ? position.old_path : position.new_path) ??
    position.new_path ??
    position.old_path ??
    "";
  if (path.length === 0) return null;
  const pick = (
    line: { new_line: number | null; old_line: number | null } | null | undefined,
  ): number | null => {
    const value = side === "old" ? line?.old_line : line?.new_line;
    return value != null && value > 0 ? value : null;
  };
  const single = pick(position);
  const start = pick(position.line_range?.start) ?? single;
  const end = pick(position.line_range?.end) ?? single;
  const line = start;
  const endLine = line !== null && end !== null && end >= line ? end : line;
  const ref = side === "old" ? position.base_sha : position.head_sha;
  return {
    path,
    side,
    line,
    endLine,
    ref: ref != null && ref.length > 0 ? ref : null,
  };
}

/**
 * GitLab's discussions → the timeline the panel shows. Each discussion is one
 * entry, so a reply stays under the comment it answers. Pages are read in
 * order, and the sort only guards that order; it is stable for equal times.
 */
export function toTimeline(raw: unknown): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const discussion of gitlabDiscussionListSchema.parse(raw)) {
    if (discussion.id.length === 0) continue;
    const notes = discussion.notes
      .filter((note) => note.body.trim().length > 0)
      .map((note) => ({
        id: note.id,
        author: note.author?.username ?? "",
        body: note.body,
        createdAt: note.created_at,
        system: note.system,
      }));
    if (notes.length === 0) continue;
    const resolvableNotes = discussion.notes.filter((note) => note.resolvable);
    const resolvable = resolvableNotes.length > 0;
    const resolved =
      resolvable && resolvableNotes.every((note) => note.resolved);
    const resolvedBy = resolved
      ? (resolvableNotes
          .map((note) => note.resolved_by?.username ?? "")
          .findLast((name) => name.length > 0) ?? null)
      : null;
    const kind = !discussion.individual_note
      ? "thread"
      : notes.every((note) => note.system)
        ? "event"
        : "comment";
    entries.push({
      id: discussion.id,
      kind,
      resolvable,
      resolved,
      resolvedBy,
      position: toDiffPosition(
        discussion.notes.find((note) => note.position != null)?.position ??
          null,
      ),
      notes,
    });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.notes[0].createdAt.localeCompare(b.entry.notes[0].createdAt) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

/**
 * A fingerprint of everything the detail view shows beyond the moving
 * status: the merge request's own `updated_at` (title, description, labels,
 * people, a new head pipeline) and its most recently updated note. Nearly
 * every other change writes a note: a comment or reply, an approval or its
 * revoke, pushed commits, a review request, a merge. Resolving a thread
 * updates the resolved notes' `updated_at`, so it shows up here too.
 *
 * `latestNotes` is GitLab's `notes?sort=desc&order_by=updated_at&per_page=1`;
 * when that call failed the key still moves with the merge request.
 */
export function activityKey(
  mergeRequestUpdatedAt: string,
  latestNotes: unknown,
): string {
  const [latest] = gitlabNoteStampListSchema.parse(latestNotes);
  return [
    mergeRequestUpdatedAt,
    latest?.id ?? 0,
    latest?.updated_at ?? "",
  ].join("|");
}

/**
 * The lines an inline thread talks about, with a little code around them.
 * Lines are 1-based. A range past the end of the file (the file changed
 * since) is clamped rather than refused.
 */
export function sliceSnippet(
  text: string,
  line: number,
  endLine: number,
): { startLine: number; lines: string[] } {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const last = Math.min(Math.max(endLine, line), all.length);
  const first = Math.max(1, Math.min(line, last) - SNIPPET_CONTEXT_BEFORE);
  const stop = Math.min(
    all.length,
    last + SNIPPET_CONTEXT_AFTER,
    first + MAX_SNIPPET_LINES - 1,
  );
  return { startLine: first, lines: all.slice(first - 1, stop) };
}

export function validateGitlabCliArgs(argv: string[]): string | null {
  const [sub, arg, ...rest] = argv;
  if (rest.length > 0) return `Unexpected argument "${rest[0]}".`;
  if (sub === undefined) return null;
  if (sub === "help" || sub === "--help") {
    return arg === undefined ? null : `Unexpected argument "${arg}".`;
  }
  if (sub === "projects" || sub === "sync") {
    return arg === undefined
      ? null
      : `Subcommand "${sub}" does not accept arguments.`;
  }
  if ((sub === "issues" || sub === "mrs") && arg !== undefined) {
    return isProjectRef(arg)
      ? null
      : `Invalid project "${arg}"; expected host/group/project.`;
  }
  return null;
}

function usernames(rows: readonly GitlabUserRow[]): string[] {
  return rows.map((row) => row.username).filter((name) => name.length > 0);
}

function toItem(
  row: GitlabItemRow,
  project: string,
  kind: "issue" | "mr",
): CachedItem {
  return {
    project,
    iid: row.iid,
    kind,
    title: row.title,
    state: row.state,
    draft: row.draft || row.work_in_progress,
    author: row.author?.username ?? "",
    labels: row.labels,
    assignees: usernames(row.assignees),
    reviewers: usernames(row.reviewers),
    url: row.web_url,
    body: row.description,
    updatedAt: row.updated_at,
  };
}

/** Parses a GitLab issue/MR list payload, dropping rows it cannot read. */
export function toItems(
  raw: unknown,
  project: string,
  kind: "issue" | "mr",
): CachedItem[] {
  const rows = gitlabItemListSchema.parse(raw);
  const items: CachedItem[] = [];
  for (const row of rows) {
    if (row !== null) items.push(toItem(row, project, kind));
  }
  return items;
}

/**
 * Open items plus a page of recently-closed (and merged) ones, so the Closed
 * filter has something to show without a live glab call per view. A project
 * with issues disabled still contributes its merge requests.
 */
export async function fetchProjectItems(
  api: GitlabApi,
  project: string,
): Promise<CachedItem[]> {
  const { path } = parseProjectRef(project);
  const base = `projects/${encodeURIComponent(path)}`;
  const order = "order_by=updated_at&sort=desc";
  const tolerant = async (endpoint: string): Promise<unknown> => {
    try {
      return await api(project, endpoint);
    } catch (error) {
      // Issues (or merge requests) disabled for the project — the 403/404
      // here must not abort the rest of the sync.
      if (/40[34]/.test(String(error))) return [];
      throw error;
    }
  };
  const [openIssues, closedIssues, openMrs, closedMrs, mergedMrs] =
    await Promise.all([
      tolerant(`${base}/issues?state=opened&per_page=${ISSUE_PAGE}&${order}`),
      tolerant(
        `${base}/issues?state=closed&per_page=${CLOSED_ISSUE_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=opened&per_page=${MR_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=closed&per_page=${CLOSED_MR_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=merged&per_page=${CLOSED_MR_PAGE}&${order}`,
      ),
    ]);
  return [
    ...toItems(openIssues, project, "issue"),
    ...toItems(closedIssues, project, "issue"),
    ...toItems(openMrs, project, "mr"),
    ...toItems(closedMrs, project, "mr"),
    ...toItems(mergedMrs, project, "mr"),
  ];
}

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  const child = execFile(
    file,
    args,
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        // `glab api` prints GitLab's error body on stdout; keep it for callers
        // that can turn it into a readable message.
        reject(
          Object.assign(
            new Error(
              `${file} ${args.slice(0, 3).join(" ")} failed: ${
                stderr.trim() || error.message
              }`,
            ),
            { stdout, stderr },
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    },
  );
  if (input !== undefined) child.stdin?.end(input);
  return promise;
}

/**
 * GitLab's own explanation from an error body — `{"message": …}` (a string, a
 * list, or a field → list map) or `{"error": "…"}` — or null when the body
 * says nothing readable.
 */
export function gitlabErrorMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const flatten = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, inner]) =>
        flatten(inner).map((text) => `${key} ${text}`),
      );
    }
    return [];
  };
  const text = [...flatten(record.message), ...flatten(record.error)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("; ");
  return text.length > 0 ? text : null;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraProjects: {
      type: "string",
      label: "Extra projects",
      description:
        'Comma-separated "host/group/project" list to track in addition to the ' +
        "projects discovered from BB projects. A bare path uses the default host.",
      default: "",
    },
    defaultHost: {
      type: "string",
      label: "Default GitLab host",
      description:
        "Host used for extra projects written without one, e.g. gitlab.com.",
      default: "gitlab.com",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where agent threads spawn for GitLab projects that are not attached to a BB project.",
    },
  });

  // ------------------------------------------------------------------
  // glab CLI plumbing. The server process may have a trimmed PATH, so probe
  // common install locations once and remember the winner.
  // ------------------------------------------------------------------
  let glabPath: string | null = null;
  let glabAuthError: string | null = "checking glab…";
  let authenticatedHosts: GitlabHost[] = [];

  async function resolveGlab(): Promise<string> {
    if (glabPath !== null) return glabPath;
    const candidates = [
      "glab",
      "/opt/homebrew/bin/glab",
      "/usr/local/bin/glab",
    ];
    for (const candidate of candidates) {
      try {
        await run(candidate, ["--version"], 5_000);
        glabPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`GitLab CLI not found. ${GLAB_HINT}`);
  }

  async function glab(
    args: string[],
    timeoutMs?: number,
    input?: string,
  ): Promise<string> {
    const file = await resolveGlab();
    const { stdout } = await run(file, args, timeoutMs, input);
    return stdout;
  }

  /**
   * Text parameters ride in the JSON body (--raw-field), which keeps commas
   * and quotes intact; array parameters such as `assignee_ids[]` belong in the
   * endpoint's query string, which GitLab also reads for PUT.
   */
  const gitlabApi: GitlabApi = async (project, endpoint, options) => {
    const { host } = parseProjectRef(project);
    const args = ["api", "--hostname", host];
    if (options?.method !== undefined) args.push("--method", options.method);
    for (const [key, value] of Object.entries(options?.fields ?? {})) {
      args.push("--raw-field", `${key}=${value}`);
    }
    let input: string | undefined;
    if (options?.json !== undefined) {
      args.push("--header", "Content-Type: application/json", "--input", "-");
      input = JSON.stringify(options.json);
    }
    args.push(endpoint);
    let stdout: string;
    try {
      stdout = await glab(args, 30_000, input);
    } catch (error) {
      // Prefer GitLab's reason ("Branch cannot be merged") over glab's bare
      // "HTTP 405", keeping the status code that callers match on.
      const body = (error as { stdout?: unknown }).stdout;
      const reason =
        typeof body === "string" ? gitlabErrorMessage(body) : null;
      if (reason === null) throw error;
      const code = String(error).match(/HTTP (\d{3})/)?.[1];
      throw new Error(code === undefined ? reason : `${reason} (HTTP ${code})`);
    }
    return stdout.trim().length === 0 ? null : (JSON.parse(stdout) as unknown);
  };

  /** Every page of a list endpoint, up to `maxPages` pages of 100. */
  async function gitlabApiPages(
    project: string,
    endpoint: string,
    maxPages: number,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    const separator = endpoint.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const batch = await gitlabApi(
        project,
        `${endpoint}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) break;
      rows.push(...(batch as unknown[]));
      if (batch.length < 100) break;
    }
    return rows;
  }

  /**
   * How this instance is reached, straight from its glab config. Unset keys
   * print nothing, and an unreadable key degrades to "not configured" rather
   * than failing the whole auth check.
   */
  async function readHostConfig(host: string): Promise<GitlabHost> {
    const read = async (key: string): Promise<string> => {
      try {
        return (await glab(["config", "get", key, "--host", host], 10_000)).trim();
      } catch {
        return "";
      }
    };
    const [subfolder, sshHost, apiHost] = await Promise.all([
      read("subfolder"),
      read("ssh_host"),
      read("api_host"),
    ]);
    return {
      host,
      subfolder,
      sshHost: sshHost.length > 0 ? sshHost : null,
      apiHost: apiHost.length > 0 ? apiHost : null,
    };
  }

  async function checkAuth(): Promise<void> {
    const file = await resolveGlab();
    // `glab auth status` writes its report to stderr and exits non-zero when
    // any configured host fails, so read the text rather than the exit code.
    const { promise, resolve } = Promise.withResolvers<string>();
    execFile(
      file,
      ["auth", "status"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
    const hosts = parseAuthenticatedHosts(await promise);
    if (hosts.length === 0) {
      glabAuthError = `GitLab CLI is not authenticated with any host. ${GLAB_HINT}`;
      throw needsConfiguration(glabAuthError);
    }
    authenticatedHosts = await Promise.all(hosts.map(readHostConfig));
    glabAuthError = null;
  }

  // ------------------------------------------------------------------
  // Project discovery: BB project git remotes → host/path. The remote comes
  // from BB's own project record, so a checkout living on an enrolled remote
  // host resolves exactly like a local one.
  // ------------------------------------------------------------------
  let projectCache: { projects: ProjectInfo[]; fetchedAt: number } | null = null;

  async function discoverProjects(force = false): Promise<ProjectInfo[]> {
    if (
      !force &&
      projectCache !== null &&
      Date.now() - projectCache.fetchedAt < 60_000
    ) {
      return projectCache.projects;
    }
    const byRef = new Map<string, ProjectInfo>();
    const addRef = (ref: string, bbProjectId: string | null): void => {
      if (byRef.has(ref)) return;
      const { host, path } = parseProjectRef(ref);
      byRef.set(ref, { project: ref, host, path, bbProjectId });
    };
    try {
      for (const bbProject of await bb.sdk.projects.list()) {
        if (bbProject.gitRemoteUrl === null) continue;
        const ref = parseGitlabRemote(bbProject.gitRemoteUrl, authenticatedHosts);
        if (ref !== null) {
          addRef(ref, bbProject.id);
          continue;
        }
        // Not one of glab's hosts. Say so once per sync: on a self-managed
        // instance the fix is `glab auth login --hostname <host>`, and silence
        // here reads as the plugin ignoring the project.
        const remoteHost = bbProject.gitRemoteUrl.match(
          /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)/i,
        );
        if (remoteHost !== null) {
          bb.log.debug(
            `project ${bbProject.id} remote host ${remoteHost[1]} is not an authenticated glab host`,
          );
        }
      }
    } catch (error) {
      bb.log.warn(
        `project discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const { extraProjects, defaultHost } = await settings.get();
    for (const raw of extraProjects.split(/[\s,]+/)) {
      if (raw.trim().length === 0) continue;
      const ref = normalizeProjectRef(raw, authenticatedHosts, defaultHost);
      if (ref !== null) addRef(ref, null);
      else bb.log.warn(`ignoring malformed extraProjects entry "${raw}"`);
    }
    const projects = [...byRef.values()];
    projectCache = { projects, fetchedAt: Date.now() };
    return projects;
  }

  // ------------------------------------------------------------------
  // SQLite cache of open issues + merge requests across tracked projects.
  // ------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       project TEXT NOT NULL,
       iid INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       draft INTEGER NOT NULL DEFAULT 0,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       assignees TEXT NOT NULL DEFAULT '[]',
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project, kind, iid)
     )`,
    `ALTER TABLE items ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]'`,
  ]);

  const cachedStringArraySchema = z.array(z.string()).catch([]);

  function rowToItem(row: Record<string, unknown>): CachedItem {
    return {
      project: String(row.project),
      iid: Number(row.iid),
      kind: row.kind === "mr" ? "mr" : "issue",
      title: String(row.title),
      state: String(row.state),
      draft: Number(row.draft) === 1,
      author: String(row.author),
      // Written by this plugin, but a corrupt row must not fail the list.
      labels: cachedStringArraySchema.parse(JSON.parse(String(row.labels))),
      assignees: cachedStringArraySchema.parse(
        JSON.parse(String(row.assignees)),
      ),
      reviewers: cachedStringArraySchema.parse(
        JSON.parse(String(row.reviewers ?? "[]")),
      ),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };
  }

  function listCachedItems(options: {
    kind?: "issue" | "mr";
    project?: string;
    query?: string;
    /** "open" → opened only; "closed" → everything else (closed, merged). */
    state?: "open" | "closed";
  }): CachedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.project !== undefined) {
      clauses.push("project = ?");
      params.push(options.project);
    }
    if (options.state === "open") {
      clauses.push("state = 'opened'");
    } else if (options.state === "closed") {
      clauses.push("state != 'opened'");
    }
    const query = options.query?.trim() ?? "";
    if (query.length > 0) {
      clauses.push(
        "(title LIKE ? OR CAST(iid AS TEXT) LIKE ? OR project LIKE ?)",
      );
      const like = `%${query.replace(/^[#!]/, "")}%`;
      params.push(like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  function getCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE project = ? AND kind = ? AND iid = ?")
      .get(project, kind, iid) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  function replaceProjectRows(project: string, items: CachedItem[]): void {
    const insert = db.prepare(
      `INSERT INTO items (project, iid, kind, title, state, draft, author, labels, assignees, reviewers, url, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE project = ?").run(project);
      for (const item of items) {
        insert.run(
          item.project,
          item.iid,
          item.kind,
          item.title,
          item.state,
          item.draft ? 1 : 0,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          JSON.stringify(item.reviewers),
          item.url,
          item.body,
          item.updatedAt,
        );
      }
    })();
  }

  /** Patch a cached row in place after a mutation so the UI updates without
      waiting for the next full sync. */
  function patchCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    patch: {
      state?: string;
      assignees?: string[];
      reviewers?: string[];
      labels?: string[];
    },
  ): void {
    if (patch.state !== undefined) {
      db.prepare(
        "UPDATE items SET state = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(patch.state, project, kind, iid);
    }
    if (patch.assignees !== undefined) {
      db.prepare(
        "UPDATE items SET assignees = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.assignees), project, kind, iid);
    }
    if (patch.reviewers !== undefined) {
      db.prepare(
        "UPDATE items SET reviewers = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.reviewers), project, kind, iid);
    }
    if (patch.labels !== undefined) {
      db.prepare(
        "UPDATE items SET labels = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.labels), project, kind, iid);
    }
    bb.realtime.publish("data-changed", {});
  }

  async function syncAll(
    force = false,
  ): Promise<{ projects: number; items: number }> {
    await checkAuth();
    const projects = await discoverProjects(force);
    // Cheap change detection so idle syncs don't wake every panel.
    const fingerprint = db.prepare(
      "SELECT project, kind, iid, state, updated_at FROM items ORDER BY project, kind, iid",
    );
    const before = JSON.stringify(fingerprint.all());
    // A project that stopped being tracked — removed from extraProjects, or
    // gone from GitLab — must not keep serving rows to lists and mentions.
    const tracked = projects.map((entry) => entry.project);
    if (tracked.length === 0) {
      db.prepare("DELETE FROM items").run();
    } else {
      db.prepare(
        `DELETE FROM items WHERE project NOT IN (${tracked.map(() => "?").join(",")})`,
      ).run(...tracked);
    }
    let total = 0;
    for (const { project } of projects) {
      try {
        const items = await fetchProjectItems(gitlabApi, project);
        replaceProjectRows(project, items);
        total += items.length;
      } catch (error) {
        bb.log.warn(
          `sync failed for ${project}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await bb.storage.kv.set("sync-cursor", {
      lastSyncedAt: new Date().toISOString(),
      projects: projects.length,
      items: total,
    });
    if (before !== JSON.stringify(fingerprint.all())) {
      bb.realtime.publish("data-changed", { items: total });
    }
    bb.log.info(`synced ${total} item(s) across ${projects.length} project(s)`);
    return { projects: projects.length, items: total };
  }

  // Initial sync + 5-minute refresh loop. NeedsConfigurationError from a
  // missing/unauthenticated glab flips the plugin to needs-configuration
  // instead of crash-looping. The abort check after each sync is load-bearing:
  // an abort that lands mid-sync would otherwise register its listener on an
  // already-aborted signal, which never fires, and the reload would wait out
  // the full interval and report the plugin degraded.
  bb.background.service("sync", {
    async start(signal) {
      while (!signal.aborted) {
        await syncAll();
        if (signal.aborted) break;
        const sleep = Promise.withResolvers<void>();
        const timer = setTimeout(sleep.resolve, SYNC_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            sleep.resolve();
          },
          { once: true },
        );
        await sleep.promise;
      }
    },
  });

  // Surface an unconfigured glab immediately instead of waiting for the
  // service's first crash.
  try {
    await checkAuth();
  } catch (error) {
    bb.status.needsConfiguration(
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------------
  // Issue/MR ↔ thread links (the pills in the UI).
  // kv: "link:<kind>:<project>!<iid>" → ThreadLink[]
  // ------------------------------------------------------------------
  async function addLink(link: ThreadLink): Promise<void> {
    const key = `link:${link.kind}:${link.project}!${link.iid}`;
    const existing = (await bb.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...existing, link]);
    bb.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await bb.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};
    for (const key of keys) {
      const links = await bb.storage.kv.get<ThreadLink[]>(key);
      if (links !== undefined && links.length > 0) {
        result[key.slice("link:".length)] = links;
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Spawning agent threads on issues / MR reviews.
  // ------------------------------------------------------------------
  async function resolveBbProjectId(project: string): Promise<string> {
    const projects = await discoverProjects();
    const info = projects.find((entry) => entry.project === project);
    if (info?.bbProjectId != null) return info.bbProjectId;
    const { defaultProject } = await settings.get();
    if (defaultProject) return defaultProject;
    throw new Error(
      `No BB project is attached to ${project}. Create a project whose checkout has ` +
        "that origin remote, or set the defaultProject plugin setting.",
    );
  }

  async function spawnOnItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, project, iid);
    const noun = kind === "mr" ? "merge request" : "issue";
    const marker = kind === "mr" ? "!" : "#";
    const title = item?.title ?? `${noun} ${marker}${iid}`;
    const bbProjectId = await resolveBbProjectId(project);
    const ref = `${project}${marker}${iid}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitLab issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  glab issue view ${iid} -R ${project} --comments`,
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a merge request, include "Closes #${iid}" in its description.`,
          ].join("\n")
        : [
            `Review GitLab merge request ${ref}: ${title}`,
            "",
            "Read the merge request and its diff:",
            `  glab mr view ${iid} -R ${project} --comments`,
            `  glab mr diff ${iid} -R ${project}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitLab unless asked.",
          ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: bbProjectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    });
    await addLink({
      kind,
      project,
      iid,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for ${noun} ${ref}`);
    return { threadId: thread.id };
  }

  // ------------------------------------------------------------------
  // Viewer identity + per-project members and labels, cached in memory so the
  // filter chips and assignee picker don't hit the network on every render.
  // ------------------------------------------------------------------
  const viewerCache = new Map<string, { username: string; fetchedAt: number }>();
  const membersCache = new Map<
    string,
    { members: GitlabUserRow[]; fetchedAt: number }
  >();
  const labelsCache = new Map<string, { labels: string[]; fetchedAt: number }>();

  async function getViewer(host?: string): Promise<string> {
    const resolvedHost = host ?? authenticatedHosts[0]?.host;
    if (resolvedHost === undefined) {
      throw needsConfiguration(`No authenticated GitLab host. ${GLAB_HINT}`);
    }
    const cached = viewerCache.get(resolvedHost);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 60 * 60_000) {
      return cached.username;
    }
    const raw = await glab(["api", "--hostname", resolvedHost, "user"], 15_000);
    const { username } = gitlabUserRowSchema.parse(JSON.parse(raw));
    if (username.length === 0) {
      throw new Error(`could not resolve the glab user on ${resolvedHost}`);
    }
    viewerCache.set(resolvedHost, { username, fetchedAt: Date.now() });
    return username;
  }

  async function getMembers(project: string): Promise<GitlabUserRow[]> {
    const cached = membersCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.members;
    }
    const { path } = parseProjectRef(project);
    const members = gitlabMemberListSchema.parse(
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/members/all?per_page=100`,
      ),
    );
    membersCache.set(project, { members, fetchedAt: Date.now() });
    return members;
  }

  /** GitLab assigns by numeric user id, so usernames need resolving first. */
  async function resolveUserIds(
    project: string,
    names: readonly string[],
  ): Promise<number[]> {
    if (names.length === 0) return [];
    const idByName = new Map<string, number>();
    for (const member of await getMembers(project)) {
      if (member.username.length > 0 && member.id > 0) {
        idByName.set(member.username, member.id);
      }
    }
    const ids: number[] = [];
    for (const name of names) {
      const known = idByName.get(name);
      if (known !== undefined) {
        ids.push(known);
        continue;
      }
      // Assignable without being a direct member (group or instance user).
      const [found] = gitlabMemberListSchema.parse(
        await gitlabApi(project, `users?username=${encodeURIComponent(name)}`),
      );
      if (found === undefined || found.id <= 0) {
        throw new Error(`unknown GitLab user "${name}"`);
      }
      ids.push(found.id);
    }
    return ids;
  }

  async function getProjectLabels(project: string): Promise<string[]> {
    const cached = labelsCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.labels;
    }
    const { path } = parseProjectRef(project);
    const rows = gitlabLabelListSchema.parse(
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/labels?per_page=100&with_counts=false`,
      ),
    );
    // Group labels come back alongside project labels and can repeat.
    const labels = [
      ...new Set(rows.map((row) => row.name.trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    labelsCache.set(project, { labels, fetchedAt: Date.now() });
    return labels;
  }

  // ------------------------------------------------------------------
  // Merge-request helpers shared by the detail view and its live status.
  // ------------------------------------------------------------------
  const projectSettingsCache = new Map<
    string,
    {
      settings: z.infer<typeof gitlabProjectSettingsSchema>;
      fetchedAt: number;
    }
  >();

  /** The project's squash and delete-branch defaults, for the merge widget. */
  async function getProjectSettings(
    project: string,
  ): Promise<z.infer<typeof gitlabProjectSettingsSchema>> {
    const cached = projectSettingsCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.settings;
    }
    const { path } = parseProjectRef(project);
    let raw: unknown;
    try {
      raw = await gitlabApi(project, `projects/${encodeURIComponent(path)}`);
    } catch (error) {
      bb.log.warn(
        `project settings for ${project} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const settings = gitlabProjectSettingsSchema.parse(raw);
    if (raw !== undefined) {
      projectSettingsCache.set(project, { settings, fetchedAt: Date.now() });
    }
    return settings;
  }

  /** A pipeline's latest jobs. Jobs are optional: a failure shows none. */
  async function loadJobs(
    project: string,
    pipelineId: number | null,
  ): Promise<z.infer<typeof jobSchema>[]> {
    if (pipelineId === null) return [];
    const { path } = parseProjectRef(project);
    let raw: unknown;
    try {
      raw = await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/pipelines/${pipelineId}/jobs?per_page=100`,
      );
    } catch (error) {
      bb.log.warn(
        `jobs of pipeline ${pipelineId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
    return gitlabJobListSchema
      .parse(raw)
      .filter((job) => job.id > 0)
      .map((job) => ({
        id: job.id,
        name: job.name,
        stage: job.stage,
        status: classifyJob(job.status, job.allow_failure),
        rawStatus: job.status,
        url: job.web_url,
      }));
  }

  /**
   * A call whose failure should degrade one section, not the whole view:
   * logged, and read as undefined (which the payload schemas catch).
   */
  async function optionalGitlabApi(
    project: string,
    endpoint: string,
  ): Promise<unknown> {
    try {
      return await gitlabApi(project, endpoint);
    } catch (error) {
      bb.log.warn(
        `optional call ${endpoint} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /** GitLab's most recently updated note on a merge request, for activityKey. */
  function latestNoteEndpoint(project: string, iid: number): string {
    return `${mergeRequestPath(project, iid)}/notes?sort=desc&order_by=updated_at&per_page=1`;
  }

  /**
   * Bring the cached list row in line with what a detail read just saw, so
   * the list agrees with the open merge request before the next sync. Only
   * a real difference writes (and so pings the list to refetch).
   */
  function syncCachedMergeRequest(
    project: string,
    iid: number,
    seen: {
      state: string;
      assignees?: string[];
      reviewers?: string[];
      labels?: string[];
    },
  ): void {
    const cached = getCachedItem("mr", project, iid);
    if (cached === null) return;
    const same = (a: string[], b: string[] | undefined) =>
      b === undefined || JSON.stringify(a) === JSON.stringify(b);
    const patch = {
      ...(cached.state !== seen.state ? { state: seen.state } : {}),
      ...(same(cached.assignees, seen.assignees)
        ? {}
        : { assignees: seen.assignees }),
      ...(same(cached.reviewers, seen.reviewers)
        ? {}
        : { reviewers: seen.reviewers }),
      ...(same(cached.labels, seen.labels) ? {} : { labels: seen.labels }),
    };
    if (Object.keys(patch).length > 0) {
      patchCachedItem("mr", project, iid, patch);
    }
  }

  /** The moving parts of a merge request, from its detail row. */
  async function toMergeRequestStatus(
    project: string,
    detail: z.infer<typeof gitlabMergeRequestRowSchema>,
    latestNotes: unknown,
  ): Promise<z.infer<typeof mergeRequestStatusSchema>> {
    const pipeline =
      detail.head_pipeline?.id != null && detail.head_pipeline.id > 0
        ? {
            id: detail.head_pipeline.id,
            status: detail.head_pipeline.status,
            url: detail.head_pipeline.web_url,
          }
        : null;
    return {
      state: detail.state,
      draft: detail.draft || detail.work_in_progress,
      sha: detail.sha,
      mergeStatus: detail.detailed_merge_status || detail.merge_status,
      hasConflicts: detail.has_conflicts,
      autoMerge: detail.merge_when_pipeline_succeeds,
      pipeline,
      jobs: await loadJobs(project, pipeline?.id ?? null),
      activityKey: activityKey(detail.updated_at, latestNotes),
    };
  }

  /** "projects/<id>/merge_requests/<iid>" for a project ref. */
  function mergeRequestPath(project: string, iid: number): string {
    const { path } = parseProjectRef(project);
    return `projects/${encodeURIComponent(path)}/merge_requests/${iid}`;
  }

  // File text at a commit, for inline-thread snippets. A commit's copy of a
  // file never changes, so a small most-recent-first cache is safe.
  const fileTextCache = new Map<string, string>();
  const FILE_TEXT_CACHE_SIZE = 30;

  async function fileTextAt(
    project: string,
    ref: string,
    filePath: string,
  ): Promise<string> {
    const key = `${project}@${ref}:${filePath}`;
    const cached = fileTextCache.get(key);
    if (cached !== undefined) {
      fileTextCache.delete(key);
      fileTextCache.set(key, cached);
      return cached;
    }
    const { path } = parseProjectRef(project);
    const file = gitlabRepositoryFileSchema.parse(
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/repository/files/${encodeURIComponent(filePath)}?ref=${ref}`,
      ),
    );
    if (file.size > MAX_SNIPPET_FILE_BYTES) {
      throw new Error("The file is too large to show here.");
    }
    const text =
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
    fileTextCache.set(key, text);
    while (fileTextCache.size > FILE_TEXT_CACHE_SIZE) {
      const oldest = fileTextCache.keys().next().value;
      if (oldest === undefined) break;
      fileTextCache.delete(oldest);
    }
    return text;
  }

  /** Human notes of a GitLab note list — GitLab's activity feed is in there too. */
  function toNotes(raw: unknown): Note[] {
    return gitlabNoteListSchema
      .parse(raw)
      .filter((row) => !row.system && row.body.trim().length > 0)
      .map((row) => ({
        author: row.author?.username ?? "",
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  /**
   * The merge request raised from a branch: an open one when the branch has
   * one, else the most recently updated. Null when the branch has none.
   */
  async function mergeRequestForBranch(
    project: string,
    branch: string,
  ): Promise<number | null> {
    const { path } = parseProjectRef(project);
    const rows = gitlabItemListSchema
      .parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/merge_requests` +
            `?source_branch=${encodeURIComponent(branch)}` +
            "&per_page=10&order_by=updated_at&sort=desc",
        ),
      )
      .filter((row) => row !== null);
    return (
      rows.find((row) => row.state === "opened")?.iid ?? rows[0]?.iid ?? null
    );
  }

  /**
   * The merge request a thread's own checkout sits on, found through the
   * branch the worktree is on.
   *
   * BB's `environments.pullRequest` runs the GitHub CLI, so on a GitLab remote
   * it reports nothing and the panel would have to ask the user to pick. The
   * branch is the link that does work.
   *
   * A thread sitting on the repo's trunk is skipped. Such a branch can still
   * match an old merge request that was raised *from* the trunk, and that
   * merge request has nothing to do with the thread.
   */
  async function branchMergeRequest(thread: {
    projectId: string | null;
    environmentId: string | null;
  }): Promise<{ project: string; iid: number } | null> {
    if (thread.environmentId === null) return null;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.isGitRepo) return null;
    const branch = environment.branchName?.trim() ?? "";
    if (branch.length === 0) return null;
    const trunks = [
      environment.defaultBranch,
      environment.baseBranch,
      environment.mergeBaseBranch,
    ].map((name) => name?.trim() ?? "");
    if (trunks.includes(branch)) return null;
    const projects = await discoverProjects();
    // The thread's own BB project when that project is tracked. Asking the
    // others as well would let a branch name that exists in two repositories
    // answer with the wrong merge request; only a thread BB cannot place at
    // all is worth that risk.
    const mine = projects.filter(
      (entry) => entry.bbProjectId === thread.projectId,
    );
    for (const entry of mine.length > 0 ? mine : projects) {
      try {
        const iid = await mergeRequestForBranch(entry.project, branch);
        if (iid !== null) return { project: entry.project, iid };
      } catch (error) {
        bb.log.debug(
          `merge request lookup failed for ${entry.project} ${branch}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return null;
  }

  /** The merge request BB itself records for a thread's environment. */
  async function environmentMergeRequest(thread: {
    environmentId: string | null;
  }): Promise<{ project: string; iid: number } | null> {
    if (thread.environmentId === null) return null;
    try {
      const result = await bb.sdk.environments.pullRequest({
        environmentId: thread.environmentId,
      });
      const match =
        result.outcome === "available"
          ? result.pullRequest.url.match(
              /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/,
            )
          : null;
      if (match === null) return null;
      const ref = `${match[1].toLowerCase()}/${match[2]}`;
      return isProjectRef(ref) ? { project: ref, iid: Number(match[3]) } : null;
    } catch {
      // BB has no answer for this environment — the branch lookup is next.
      return null;
    }
  }

  // ------------------------------------------------------------------
  // rpc — the frontend data plane.
  // ------------------------------------------------------------------
  bb.rpc.register(gitlabRpcContract, {
    /** () → auth/sync status for the panel banner. */
    async status() {
      const cursor = await bb.storage.kv.get<{
        lastSyncedAt: string;
        projects: number;
        items: number;
      }>("sync-cursor");
      return {
        glabOk: glabAuthError === null,
        glabError: glabAuthError,
        hosts: authenticatedHosts.map((entry) => entry.host),
        projects: await discoverProjects(),
        lastSyncedAt: cursor?.lastSyncedAt ?? null,
      };
    },

    /** () → force a full sync now. */
    async refresh() {
      return await syncAll(true);
    },

    /** { kind?, project?, state? } → cached items, newest first. */
    async listItems(input) {
      return {
        items: listCachedItems({
          kind: input.kind,
          project: input.project,
          state: input.state,
        }),
      };
    },

    /** () → the authenticated glab username, for "assign to me" affordances. */
    async viewer() {
      return { username: await getViewer() };
    },

    /** { project } → usernames that can be assigned in that project. */
    async assignableUsers(input) {
      const members = await getMembers(input.project);
      return {
        users: [...new Set(usernames(members))].sort((a, b) =>
          a.localeCompare(b),
        ),
      };
    },

    /** { project } → labels available in that project. */
    async projectLabels(input) {
      return { labels: await getProjectLabels(input.project) };
    },

    /** { project, iid, state } → close or reopen an issue. */
    async setIssueState({ project, iid, state }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      const event = state === "closed" ? "close" : "reopen";
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/issues/${iid}?state_event=${event}`,
        { method: "PUT" },
      );
      patchCachedItem("issue", project, iid, {
        state: state === "closed" ? "closed" : "opened",
      });
      return { ok: true };
    },

    /** { project, iid, assignees } → set the exact assignee list. */
    async setAssignees({
      project,
      iid,
      assignees,
    }): Promise<{ ok: true; assignees: string[] }> {
      const next = [...new Set(assignees)];
      const { path } = parseProjectRef(project);
      const ids = await resolveUserIds(project, next);
      // GitLab clears the assignee list when the id list is exactly [0].
      const query = (ids.length > 0 ? ids : [0])
        .map((id) => `assignee_ids[]=${id}`)
        .join("&");
      const updated = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/issues/${iid}?${query}`,
          { method: "PUT" },
        ),
      );
      const applied = usernames(updated.assignees);
      patchCachedItem("issue", project, iid, { assignees: applied });
      return { ok: true, assignees: applied };
    },

    /** { project, iid, labels } → set the exact issue label list. */
    async setLabels({
      project,
      iid,
      labels,
    }): Promise<{ ok: true; labels: string[] }> {
      const next = [
        ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
      ];
      const { path } = parseProjectRef(project);
      const updated = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/issues/${iid}`,
          { method: "PUT", fields: { labels: next.join(",") } },
        ),
      );
      patchCachedItem("issue", project, iid, { labels: updated.labels });
      return { ok: true, labels: updated.labels };
    },

    /** { project, iid } → live issue detail incl. comments. */
    async getIssue({ project, iid }) {
      const { path } = parseProjectRef(project);
      const base = `projects/${encodeURIComponent(path)}/issues/${iid}`;
      const [detailRaw, notesRaw] = await Promise.all([
        gitlabApi(project, base),
        gitlabApi(
          project,
          `${base}/notes?per_page=100&sort=asc&order_by=created_at`,
        ),
      ]);
      const detail = gitlabItemRowSchema.parse(detailRaw);
      return {
        issue: {
          project,
          iid,
          title: detail.title,
          state: detail.state,
          author: detail.author?.username ?? "",
          body: detail.description,
          labels: detail.labels,
          assignees: usernames(detail.assignees),
          url: detail.web_url,
          updatedAt: detail.updated_at,
          notes: toNotes(notesRaw),
        },
      };
    },

    /**
     * { project, iid } → full merge-request detail: overview, pipeline and
     * jobs (GitLab's answer to checks), approvals, merge defaults, the
     * activity timeline, and per-file diffs. Approvals, diffs, jobs, and the
     * project's settings are optional on any given instance or plan, so a
     * failure there degrades that section instead of the whole view.
     */
    async getMergeRequest({ project, iid }) {
      const base = mergeRequestPath(project, iid);
      const optional = (endpoint: string) =>
        optionalGitlabApi(project, endpoint);
      // The activity stamp (this row's updated_at and the latest note) is
      // read before anything it vouches for. A change landing in between
      // then shows in the view but not in the stamp, which costs one extra
      // reload on the next poll; the other order would hide it for good.
      const [detailRaw, latestNotes] = await Promise.all([
        gitlabApi(project, base),
        optional(latestNoteEndpoint(project, iid)),
      ]);
      // The timeline is the conversation itself, so a failure is reported
      // in the view rather than passed off as "no comments yet".
      const timelineRead = gitlabApiPages(
        project,
        `${base}/discussions`,
        DISCUSSION_PAGES,
      ).then(
        (rows) => ({ timeline: toTimeline(rows), timelineError: null }),
        (error: unknown) => ({
          timeline: [],
          timelineError: error instanceof Error ? error.message : String(error),
        }),
      );
      const [diffsRaw, approvalsRaw, settings, timelineResult] =
        await Promise.all([
          optional(`${base}/diffs?per_page=${DIFF_PAGE}`),
          optional(`${base}/approvals`),
          getProjectSettings(project),
          timelineRead,
        ]);
      const detail = gitlabMergeRequestRowSchema.parse(detailRaw);
      const status = await toMergeRequestStatus(project, detail, latestNotes);
      syncCachedMergeRequest(project, iid, {
        state: detail.state,
        assignees: usernames(detail.assignees),
        reviewers: usernames(detail.reviewers),
        labels: detail.labels,
      });

      let additions = 0;
      let deletions = 0;
      const files = gitlabDiffListSchema.parse(diffsRaw).map((file) => {
        const counts = countDiffLines(file.diff);
        additions += counts.additions;
        deletions += counts.deletions;
        return {
          path: file.new_path || file.old_path,
          status: file.new_file
            ? "added"
            : file.deleted_file
              ? "deleted"
              : file.renamed_file
                ? "renamed"
                : "modified",
          additions: counts.additions,
          deletions: counts.deletions,
          // Very large diffs stay on GitLab — the panel links out instead.
          patch:
            file.diff.length > 0 && file.diff.length <= MAX_PATCH_BYTES
              ? file.diff
              : null,
        };
      });

      const approvals = gitlabApprovalsSchema.parse(approvalsRaw);
      const changesCount = Number.parseInt(String(detail.changes_count), 10);
      const changedFiles = Number.isFinite(changesCount)
        ? changesCount
        : files.length;

      // "always" and "never" decide for everyone; otherwise the choice saved
      // on the merge request stands, as it does in GitLab's merge widget.
      const squash =
        settings.squash_option === "always"
          ? true
          : settings.squash_option === "never"
            ? false
            : detail.squash;

      return {
        mergeRequest: {
          ...status,
          project,
          iid,
          title: detail.title,
          author: detail.author?.username ?? "",
          body: detail.description,
          url: detail.web_url,
          createdAt: detail.created_at,
          updatedAt: detail.updated_at,
          sourceBranch: detail.source_branch,
          targetBranch: detail.target_branch,
          additions,
          deletions,
          changedFiles,
          // The page cutoff is the only thing that truncates the diff list;
          // changes_count can disagree for its own reasons ("1000+", files
          // GitLab returns without diff text) and must not fake truncation.
          filesTruncated: files.length >= DIFF_PAGE,
          labels: detail.labels,
          assignees: usernames(detail.assignees),
          reviewers: usernames(detail.reviewers),
          approvalsRequired: approvals.approvals_required,
          approvalsLeft: approvals.approvals_left,
          approvedBy: approvals.approved_by
            .map((entry) => entry.user?.username ?? "")
            .filter((name) => name.length > 0),
          userHasApproved: approvals.user_has_approved,
          userCanApprove: approvals.user_can_approve,
          canMerge: detail.user?.can_merge ?? false,
          squash,
          squashOption: settings.squash_option,
          removeSourceBranch:
            detail.force_remove_source_branch ??
            settings.remove_source_branch_after_merge,
          mergeError:
            detail.merge_error !== null && detail.merge_error.trim().length > 0
              ? detail.merge_error
              : null,
          blockingDiscussionsResolved: detail.blocking_discussions_resolved,
          ...timelineResult,
          files,
        },
      };
    },

    /**
     * { project, iid } → the parts that move while a merge request is open:
     * state, merge status, pipeline, jobs, plus the activity stamp that
     * tells the panel when the rest needs a reload. Three small API calls,
     * cheap enough for the panel to poll the whole time it is open.
     */
    async getMergeRequestStatus({ project, iid }) {
      const [detailRaw, latestNotes] = await Promise.all([
        gitlabApi(project, mergeRequestPath(project, iid)),
        optionalGitlabApi(project, latestNoteEndpoint(project, iid)),
      ]);
      const detail = gitlabMergeRequestRowSchema.parse(detailRaw);
      syncCachedMergeRequest(project, iid, { state: detail.state });
      return await toMergeRequestStatus(project, detail, latestNotes);
    },

    /**
     * { project, iid, approved, sha } → approve or revoke the viewer's
     * approval. The sha makes GitLab refuse when new commits arrived since
     * the viewer looked.
     */
    async setApproval({ project, iid, approved, sha }): Promise<{ ok: true }> {
      const base = mergeRequestPath(project, iid);
      await gitlabApi(
        project,
        approved ? `${base}/approve` : `${base}/unapprove`,
        approved ? { method: "POST", json: { sha } } : { method: "POST" },
      );
      return { ok: true };
    },

    /**
     * { project, iid, sha, squash, removeSourceBranch, autoMerge } → merge
     * now, or set it to merge when the pipeline succeeds. GitLab refuses when
     * the head is no longer `sha`, so the viewer merges what they saw.
     */
    async mergeMergeRequest({
      project,
      iid,
      sha,
      squash,
      removeSourceBranch,
      autoMerge,
    }) {
      const updated = gitlabMergeRequestRowSchema.parse(
        await gitlabApi(project, `${mergeRequestPath(project, iid)}/merge`, {
          method: "PUT",
          json: {
            sha,
            squash,
            should_remove_source_branch: removeSourceBranch,
            ...(autoMerge ? { auto_merge: true } : {}),
          },
        }),
      );
      if (updated.state === "merged") {
        patchCachedItem("mr", project, iid, { state: "merged" });
      }
      return {
        state: updated.state,
        autoMerge: updated.merge_when_pipeline_succeeds,
      };
    },

    /** { project, iid } → drop "merge when the pipeline succeeds". */
    async cancelAutoMerge({ project, iid }): Promise<{ ok: true }> {
      await gitlabApi(
        project,
        `${mergeRequestPath(project, iid)}/cancel_merge_when_pipeline_succeeds`,
        { method: "POST" },
      );
      return { ok: true };
    },

    /**
     * { project, iid } → rebase the source branch onto the target. GitLab
     * does it in the background; the merge status reads "checking" meanwhile.
     */
    async rebaseMergeRequest({ project, iid }): Promise<{ ok: true }> {
      await gitlabApi(project, `${mergeRequestPath(project, iid)}/rebase`, {
        method: "PUT",
      });
      return { ok: true };
    },

    /**
     * { project, iid, reviewers?, assignees? } → set the exact reviewer and/or
     * assignee lists; a list left out is not touched. GitLab reads [0] as
     * "nobody".
     */
    async setMergeRequestPeople({
      project,
      iid,
      reviewers,
      assignees,
    }): Promise<{ ok: true; reviewers: string[]; assignees: string[] }> {
      const json: Record<string, unknown> = {};
      if (reviewers !== undefined) {
        const ids = await resolveUserIds(project, [...new Set(reviewers)]);
        json.reviewer_ids = ids.length > 0 ? ids : [0];
      }
      if (assignees !== undefined) {
        const ids = await resolveUserIds(project, [...new Set(assignees)]);
        json.assignee_ids = ids.length > 0 ? ids : [0];
      }
      const updated = gitlabMergeRequestRowSchema.parse(
        await gitlabApi(project, mergeRequestPath(project, iid), {
          method: "PUT",
          json,
        }),
      );
      const applied = {
        reviewers: usernames(updated.reviewers),
        assignees: usernames(updated.assignees),
      };
      patchCachedItem("mr", project, iid, applied);
      return { ok: true, ...applied };
    },

    /**
     * { project, iid } → start a new merge-request pipeline, the same one
     * GitLab's "Run pipeline" button starts.
     */
    async runPipeline({ project, iid }): Promise<{ ok: true }> {
      await gitlabApi(project, `${mergeRequestPath(project, iid)}/pipelines`, {
        method: "POST",
      });
      return { ok: true };
    },

    /** { project, pipelineId, action } → retry failed jobs, or cancel. */
    async pipelineAction({ project, pipelineId, action }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/pipelines/${pipelineId}/${action}`,
        { method: "POST" },
      );
      return { ok: true };
    },

    /** { project, jobId, action } → start a manual job, retry, or cancel. */
    async jobAction({ project, jobId, action }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/jobs/${jobId}/${action}`,
        { method: "POST" },
      );
      return { ok: true };
    },

    /**
     * { project, iid, discussionId, body } → reply inside a thread. Replying
     * to a single comment turns it into a thread, as it does on GitLab.
     */
    async replyToDiscussion({
      project,
      iid,
      discussionId,
      body,
    }): Promise<{ ok: true }> {
      await gitlabApi(
        project,
        `${mergeRequestPath(project, iid)}/discussions/${discussionId}/notes`,
        { method: "POST", json: { body } },
      );
      return { ok: true };
    },

    /** { project, iid, discussionId, resolved } → resolve or reopen a thread. */
    async setDiscussionResolved({
      project,
      iid,
      discussionId,
      resolved,
    }): Promise<{ ok: true }> {
      await gitlabApi(
        project,
        `${mergeRequestPath(project, iid)}/discussions/${discussionId}`,
        { method: "PUT", json: { resolved } },
      );
      return { ok: true };
    },

    /**
     * { project, ref, path, line, endLine } → the lines an inline thread is
     * about, read from the commit it was written against, so the code still
     * matches the comment after later pushes.
     */
    async getDiffSnippet({ project, ref, path, line, endLine }) {
      return sliceSnippet(await fileTextAt(project, ref, path), line, endLine);
    },

    /** { project, iid, body } → add an issue comment. */
    async commentIssue({ project, iid, body }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/issues/${iid}/notes`,
        { method: "POST", fields: { body } },
      );
      return { ok: true };
    },

    /** { project, iid, body } → add a merge-request comment. */
    async commentMergeRequest({ project, iid, body }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/merge_requests/${iid}/notes`,
        { method: "POST", fields: { body } },
      );
      return { ok: true };
    },

    /** { project, title, body? } → create an issue, refresh, return iid+url. */
    async createIssue(input) {
      const { path } = parseProjectRef(input.project);
      const created = gitlabItemRowSchema.parse(
        await gitlabApi(
          input.project,
          `projects/${encodeURIComponent(path)}/issues`,
          {
            method: "POST",
            fields: { title: input.title, description: input.body ?? "" },
          },
        ),
      );
      try {
        replaceProjectRows(
          input.project,
          await fetchProjectItems(gitlabApi, input.project),
        );
        bb.realtime.publish("data-changed", {});
      } catch {
        // creation succeeded; the next scheduled sync will pick it up
      }
      return { iid: created.iid, url: created.web_url };
    },

    /** { project, iid } → spawn a worker thread on an issue. */
    async startWork({ project, iid }) {
      return await spawnOnItem("issue", project, iid);
    },

    /** { project, iid } → spawn a review thread on a merge request. */
    async startReview({ project, iid }) {
      return await spawnOnItem("mr", project, iid);
    },

    /**
     * { threadId } → the merge request most relevant to a BB thread: the
     * thread's own environment MR (the branch the agent pushed) first, else an
     * MR this thread was spawned to review. Null when neither exists.
     */
    async mergeRequestForThread({ threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const recorded = await environmentMergeRequest(thread);
        if (recorded !== null) return { mergeRequest: recorded };
        const fromBranch = await branchMergeRequest(thread);
        if (fromBranch !== null) return { mergeRequest: fromBranch };
      } catch (error) {
        // no environment / lookup failed — fall through to spawn links
        bb.log.debug(
          `merge request for thread ${threadId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const links = await listAllLinks();
      for (const [key, threadLinks] of Object.entries(links)) {
        if (!key.startsWith("mr:")) continue;
        const separator = key.lastIndexOf("!");
        if (separator < 0) continue;
        const project = key.slice("mr:".length, separator);
        const iid = Number(key.slice(separator + 1));
        if (!isProjectRef(project) || !Number.isInteger(iid)) continue;
        if (threadLinks.some((link) => link.threadId === threadId)) {
          return { mergeRequest: { project, iid } };
        }
      }
      return { mergeRequest: null };
    },

    /** () → every issue/MR → thread link, keyed "<kind>:<project>!<iid>". */
    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  // ------------------------------------------------------------------
  // Mentions: issues (# as on GitLab) and merge requests (! as on GitLab)
  // attach their details as agent context. Search reads the cache (2s time
  // box); resolve prefers a live call and falls back to the cache so a
  // network blip doesn't block the send.
  // ------------------------------------------------------------------
  function mentionItems(kind: "issue" | "mr", query: string) {
    const marker = kind === "mr" ? "!" : "#";
    return listCachedItems({ kind, query, state: "open" })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.project}${marker}${item.iid}`,
        title: `${marker}${item.iid} ${item.title}`,
        subtitle: item.project,
      }));
  }

  async function mentionContext(
    kind: "issue" | "mr",
    itemId: string,
  ): Promise<{ context: string }> {
    const marker = kind === "mr" ? "!" : "#";
    const separator = itemId.lastIndexOf(marker);
    const project = separator < 0 ? "" : itemId.slice(0, separator);
    const iid = Number(itemId.slice(separator + 1));
    if (!isProjectRef(project) || !Number.isInteger(iid) || iid <= 0) {
      throw new Error(`malformed mention id "${itemId}"`);
    }
    const { path } = parseProjectRef(project);
    const noun = kind === "mr" ? "merge request" : "issue";
    const collection = kind === "mr" ? "merge_requests" : "issues";
    const command = kind === "mr" ? "mr" : "issue";
    try {
      const detail = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/${collection}/${iid}`,
        ),
      );
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${detail.title}`,
          "",
          `State: ${detail.state} · Author: ${detail.author?.username ?? ""}`,
          `URL: ${detail.web_url}`,
          "",
          detail.description.length > 0 ? detail.description : "(no description)",
          "",
          `For full comments/diff run: glab ${command} view ${iid} -R ${project} --comments`,
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, project, iid);
      if (cached === null) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  bb.ui.registerMentionProvider({
    id: "issue",
    label: "GitLab issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  bb.ui.registerMentionProvider({
    id: "mr",
    label: "GitLab merge requests",
    triggers: ["@", "!"],
    search({ query }) {
      return mentionItems("mr", query);
    },
    resolve(itemId) {
      return mentionContext("mr", itemId);
    },
  });

  // ------------------------------------------------------------------
  // CLI: `bb gitlab …` for agents and terminals.
  // ------------------------------------------------------------------
  const USAGE = [
    "Usage:",
    "  bb gitlab projects           List tracked GitLab projects",
    "  bb gitlab issues [project]   List cached open issues",
    "  bb gitlab mrs [project]      List cached open merge requests",
    "  bb gitlab sync               Refresh the cache from GitLab now",
    "",
    "A project is written host-qualified: gitlab.com/group/subgroup/app",
  ].join("\n");

  bb.cli.register({
    name: "gitlab",
    summary: "Browse tracked GitLab projects, issues, and merge requests",
    commands: [
      {
        name: "projects",
        summary: "List tracked GitLab projects",
        usage: "bb gitlab projects",
      },
      {
        name: "issues",
        summary: "List cached open issues",
        usage: "bb gitlab issues [host/group/project]",
      },
      {
        name: "mrs",
        summary: "List cached open merge requests",
        usage: "bb gitlab mrs [host/group/project]",
      },
      {
        name: "sync",
        summary: "Refresh the cache from GitLab now",
        usage: "bb gitlab sync",
      },
    ],
    async run(argv) {
      const [sub, arg] = argv;
      try {
        const validationError = validateGitlabCliArgs(argv);
        if (validationError !== null) {
          return { exitCode: 1, stderr: `${validationError}\n${USAGE}` };
        }
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "projects") {
          const projects = await discoverProjects(true);
          if (projects.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No tracked projects. Attach a BB project whose checkout has a GitLab " +
                "origin remote, or set extraProjects.",
            };
          }
          return {
            exitCode: 0,
            stdout: projects
              .map(
                (entry) =>
                  `${entry.project}${
                    entry.bbProjectId !== null ? `\t(${entry.bbProjectId})` : ""
                  }`,
              )
              .join("\n"),
          };
        }
        if (sub === "issues" || sub === "mrs") {
          const kind = sub === "mrs" ? "mr" : "issue";
          const marker = kind === "mr" ? "!" : "#";
          const items = listCachedItems({
            kind,
            project: isProjectRef(arg) ? arg : undefined,
            state: "open",
          });
          if (items.length === 0) {
            return {
              exitCode: 0,
              stdout: "Nothing cached. Run `bb gitlab sync` first.",
            };
          }
          return {
            exitCode: 0,
            stdout: items
              .map(
                (item) =>
                  `${item.project}${marker}${item.iid}\t[${
                    item.draft ? "draft" : item.state
                  }]\t${item.title}`,
              )
              .join("\n"),
          };
        }
        if (sub === "sync") {
          const { projects, items } = await syncAll(true);
          return {
            exitCode: 0,
            stdout: `Synced ${items} item(s) across ${projects} project(s).`,
          };
        }
        return {
          exitCode: 1,
          stderr: `Unknown subcommand "${sub}".\n${USAGE}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
