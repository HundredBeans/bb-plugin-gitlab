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
const mergeRequestSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    title: z.string(),
    state: z.string(),
    draft: z.boolean(),
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
    /** GitLab's detailed_merge_status, e.g. "mergeable", "need_rebase". */
    mergeStatus: z.string(),
    hasConflicts: z.boolean(),
    approvalsRequired: z.number().int().nonnegative(),
    approvalsLeft: z.number().int().nonnegative(),
    approvedBy: z.array(z.string()),
    pipeline: z
      .object({ status: z.string(), url: z.string() })
      .strict()
      .nullable(),
    jobs: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          rawStatus: z.string(),
          url: z.string(),
        })
        .strict(),
    ),
    notes: z.array(noteSchema),
    discussions: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          resolved: z.boolean(),
          notes: z.array(noteSchema),
        })
        .strict(),
    ),
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
  head_pipeline: z
    .looseObject({
      id: z.number().int().nullable().catch(null),
      status: z.string().catch(""),
      web_url: z.string().catch(""),
    })
    .nullish()
    .catch(null),
});
const gitlabNoteRowSchema = z.looseObject({
  body: z.string().catch(""),
  system: z.boolean().catch(false),
  created_at: z.string().catch(""),
  resolvable: z.boolean().catch(false),
  resolved: z.boolean().catch(false),
  author: gitlabUserRowSchema.nullish().catch(null),
  position: z
    .looseObject({
      new_path: z.string().nullable().catch(null),
      old_path: z.string().nullable().catch(null),
      new_line: z.number().int().nullable().catch(null),
      old_line: z.number().int().nullable().catch(null),
    })
    .nullish()
    .catch(null),
});
const gitlabNoteListSchema = z.array(gitlabNoteRowSchema).catch([]);
const gitlabDiscussionListSchema = z
  .array(z.looseObject({ notes: gitlabNoteListSchema }))
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
      name: z.string().catch("job"),
      status: z.string().catch(""),
      web_url: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabApprovalsSchema = z
  .looseObject({
    approvals_required: z.number().int().nonnegative().catch(0),
    approvals_left: z.number().int().nonnegative().catch(0),
    approved_by: z
      .array(z.looseObject({ user: gitlabUserRowSchema.nullish().catch(null) }))
      .catch([]),
  })
  .catch({ approvals_required: 0, approvals_left: 0, approved_by: [] });
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

/** Runs `glab api` against the host a project ref names, returning raw JSON. */
type GitlabApi = (
  project: string,
  endpoint: string,
  options?: { method?: "POST" | "PUT"; fields?: Record<string, string> },
) => Promise<unknown>;

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
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    file,
    args,
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${file} ${args.slice(0, 3).join(" ")} failed: ${
              stderr.trim() || error.message
            }`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    },
  );
  return promise;
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

  async function glab(args: string[], timeoutMs?: number): Promise<string> {
    const file = await resolveGlab();
    const { stdout } = await run(file, args, timeoutMs);
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
    args.push(endpoint);
    return JSON.parse(await glab(args, 30_000)) as unknown;
  };

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
    patch: { state?: string; assignees?: string[]; labels?: string[] },
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
     * { project, iid } → full merge-request detail: overview, pipeline jobs
     * (GitLab's answer to checks), approvals, conversation notes, inline
     * discussion threads, and per-file diffs. Approvals, discussions, diffs,
     * and jobs are optional on any given instance or plan, so a failure there
     * degrades that section instead of the whole view.
     */
    async getMergeRequest({ project, iid }) {
      const { path } = parseProjectRef(project);
      const encoded = encodeURIComponent(path);
      const base = `projects/${encoded}/merge_requests/${iid}`;
      const optional = async (endpoint: string): Promise<unknown> => {
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
      };
      const [detailRaw, notesRaw, discussionsRaw, diffsRaw, approvalsRaw] =
        await Promise.all([
          gitlabApi(project, base),
          gitlabApi(
            project,
            `${base}/notes?per_page=100&sort=asc&order_by=created_at`,
          ),
          optional(`${base}/discussions?per_page=100`),
          optional(`${base}/diffs?per_page=${DIFF_PAGE}`),
          optional(`${base}/approvals`),
        ]);
      const detail = gitlabMergeRequestRowSchema.parse(detailRaw);

      const pipelineId = detail.head_pipeline?.id ?? null;
      const jobs = gitlabJobListSchema
        .parse(
          pipelineId === null
            ? []
            : await optional(
                `projects/${encoded}/pipelines/${pipelineId}/jobs?per_page=100`,
              ),
        )
        .map((job) => ({
          name: job.name,
          status: classifyJobStatus(job.status),
          rawStatus: job.status,
          url: job.web_url,
        }));

      // A discussion whose notes carry a diff position is an inline review
      // thread; everything else already showed up in the conversation notes.
      const discussions: Array<{
        path: string;
        line: number | null;
        resolved: boolean;
        notes: Note[];
      }> = [];
      for (const discussion of gitlabDiscussionListSchema.parse(
        discussionsRaw,
      )) {
        const position = discussion.notes.find(
          (note) => note.position != null,
        )?.position;
        if (position == null) continue;
        const notes = discussion.notes
          .filter((note) => !note.system && note.body.trim().length > 0)
          .map((note) => ({
            author: note.author?.username ?? "",
            body: note.body,
            createdAt: note.created_at,
          }));
        if (notes.length === 0) continue;
        discussions.push({
          path: position.new_path ?? position.old_path ?? "",
          line: position.new_line ?? position.old_line,
          resolved: discussion.notes.every(
            (note) => !note.resolvable || note.resolved,
          ),
          notes,
        });
      }

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

      return {
        mergeRequest: {
          project,
          iid,
          title: detail.title,
          state: detail.state,
          draft: detail.draft || detail.work_in_progress,
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
          mergeStatus: detail.detailed_merge_status || detail.merge_status,
          hasConflicts: detail.has_conflicts,
          approvalsRequired: approvals.approvals_required,
          approvalsLeft: approvals.approvals_left,
          approvedBy: approvals.approved_by
            .map((entry) => entry.user?.username ?? "")
            .filter((name) => name.length > 0),
          pipeline:
            detail.head_pipeline == null
              ? null
              : {
                  status: detail.head_pipeline.status,
                  url: detail.head_pipeline.web_url,
                },
          jobs,
          notes: toNotes(notesRaw),
          discussions,
          files,
        },
      };
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
