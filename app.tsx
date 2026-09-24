// bb-plugin-gitlab — the frontend bundle.
//
// A GitLab panel: Issues / Merge requests as a filterable list (project
// filter, Open/Closed chips, "Assigned to me", text search — all pushed to
// the backend's cache query), inline state + assignee editing, and detail
// views for both kinds. The merge-request view is the deep one: overview
// (source → target, draft, merge status, conflicts, churn), pipeline and its
// jobs, approvals, reviewers, conversation notes, inline discussion threads,
// and per-file diffs rendered by this plugin's own unified-diff component.
// "Send agent" / "Review with agent" buttons sit wherever an issue or merge
// request shows up, and every spawned thread comes back as a ⚡ pill.
//
// Sub-navigation lives in the nav panel's subPath, so deep links are
// #/issues/<host>/<namespace/path>/<iid> and
// #/merge_requests/<host>/<namespace/path>/<iid> — parsed from the right
// (last segment is the iid, first is the host, everything between is the
// project path) so subgroups of any depth work. A threadPanelAction opens
// the same merge-request view in a thread's right panel, auto-resolved to
// that thread's merge request.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { gitlabRpcContract } from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  MARKER,
  matchesItemQuery,
  parseItemQuery,
  QUALIFIER_KEYS,
  queryProject,
  suggestQueryTokens,
  withQueryProject,
  type Kind,
  type ParsedItemQuery,
  type QuerySuggestion,
  type QueryVocabulary,
} from "@/lib/item-query";

// ---------------------------------------------------------------------------
// Shapes, mirroring the rpc contract in server.ts. Declared here rather than
// inferred so the panel's own reads are checked against the contract.
// ---------------------------------------------------------------------------

interface ProjectInfo {
  /** Host-qualified ref, e.g. "gitlab.com/group/subgroup/app". */
  project: string;
  host: string;
  path: string;
  bbProjectId: string | null;
}

interface Item {
  project: string;
  iid: number;
  kind: Kind;
  title: string;
  /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
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

interface IssueDetail {
  project: string;
  iid: number;
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  assignees: string[];
  url: string;
  updatedAt: string;
  notes: Note[];
}

interface Job {
  id: number;
  name: string;
  stage: string;
  /** "warning" is a failed job the pipeline is allowed to ignore. */
  status: "success" | "failure" | "warning" | "pending" | "neutral";
  /** GitLab's own word for it — "manual", "skipped", "canceled", … */
  rawStatus: string;
  url: string;
}

interface Pipeline {
  id: number;
  status: string;
  url: string;
}

interface TimelineNote {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  /** GitLab's own event text, e.g. "changed this line in version 2". */
  system: boolean;
}

/** Where an inline thread sits; line fields are null for a whole file. */
interface DiffPosition {
  path: string;
  /** "old" only for a removed line. */
  side: "new" | "old";
  line: number | null;
  endLine: number | null;
  /** The commit holding that copy of the file. */
  ref: string | null;
}

interface TimelineEntry {
  /** GitLab's discussion id. */
  id: string;
  kind: "event" | "comment" | "thread";
  resolvable: boolean;
  resolved: boolean;
  resolvedBy: string | null;
  position: DiffPosition | null;
  notes: TimelineNote[];
}

/** The parts of a merge request that move while it is open. */
interface MergeRequestStatus {
  state: string;
  draft: boolean;
  sha: string;
  /** GitLab's detailed_merge_status, e.g. "mergeable", "need_rebase". */
  mergeStatus: string;
  hasConflicts: boolean;
  /** True while "merge when the pipeline succeeds" is set. */
  autoMerge: boolean;
  pipeline: Pipeline | null;
  jobs: Job[];
}

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Raw unified diff, null when GitLab's copy is too big to inline. */
  patch: string | null;
}

interface MergeRequestDetail extends MergeRequestStatus {
  project: string;
  iid: number;
  title: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  sourceBranch: string;
  targetBranch: string;
  /** Summed over `files` only — partial whenever filesTruncated is true. */
  additions: number;
  deletions: number;
  /** GitLab's own total, which can exceed files.length. */
  changedFiles: number;
  /** True when the merge request has more files than one diff page. */
  filesTruncated: boolean;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  approvalsRequired: number;
  approvalsLeft: number;
  approvedBy: string[];
  userHasApproved: boolean;
  userCanApprove: boolean;
  canMerge: boolean;
  /** Merge defaults, as GitLab's own merge widget would pre-fill them. */
  squash: boolean;
  /** "always" and "never" lock the squash choice for the project. */
  squashOption: "always" | "never" | "default_on" | "default_off";
  removeSourceBranch: boolean;
  mergeError: string | null;
  blockingDiscussionsResolved: boolean;
  timeline: TimelineEntry[];
  /** Set when the discussions could not be read. */
  timelineError: string | null;
  files: DiffFile[];
}

interface ThreadLink {
  kind: Kind;
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
}

type LinksMap = Record<string, ThreadLink[]>;

interface Status {
  glabOk: boolean;
  glabError: string | null;
  hosts: string[];
  projects: ProjectInfo[];
  lastSyncedAt: string | null;
}

/** The key `listLinks` files a spawned thread under. */
function linkKey(kind: Kind, project: string, iid: number): string {
  return `${kind}:${project}!${iid}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The trailing segment of a project ref — enough to identify it in a row. */
function shortProject(project: string): string {
  const parts = project.split("/");
  return parts[parts.length - 1] ?? project;
}

// ---------------------------------------------------------------------------
// Sub-routing — the navPanel owns /plugins/gitlab/gitlab/*, so sub-navigation
// lives in the route's subPath: "issues", "merge_requests", "new",
// "issues/<host>/<namespace/path>/<iid>". Deep-linkable, and browser
// back/forward walks panel history.
// ---------------------------------------------------------------------------

const PANEL_PATH = "gitlab";

type Route =
  | { view: "issues" }
  | { view: "merge_requests" }
  | { view: "new" }
  | { view: "issue"; project: string; iid: number }
  | { view: "merge_request"; project: string; iid: number };

/**
 * `[host, ...namespace, iid]` → a project ref plus its iid. Parsed from the
 * right because a GitLab namespace has any number of segments.
 */
function parseItemPath(
  parts: string[],
): { project: string; iid: number } | null {
  if (parts.length < 3) return null;
  const iid = Number(parts[parts.length - 1]);
  if (!Number.isInteger(iid) || iid <= 0) return null;
  return { project: parts.slice(0, -1).join("/"), iid };
}

function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "merge_requests") {
    const item = parseItemPath(parts.slice(1));
    return item === null
      ? { view: "merge_requests" }
      : { view: "merge_request", project: item.project, iid: item.iid };
  }
  if (parts[0] === "new") return { view: "new" };
  if (parts[0] === "issues") {
    const item = parseItemPath(parts.slice(1));
    return item === null
      ? { view: "issues" }
      : { view: "issue", project: item.project, iid: item.iid };
  }
  // Opening the page with no sub-path lands on merge requests: the panel is
  // read far more often to see what is waiting for review than to browse
  // issues. `issues` in the sub-path still goes straight there.
  return { view: "merge_requests" };
}

function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "issues":
      return "issues";
    case "merge_requests":
      return "merge_requests";
    case "new":
      return "new";
    case "issue":
      return `issues/${route.project}/${route.iid}`;
    case "merge_request":
      return `merge_requests/${route.project}/${route.iid}`;
  }
}

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Data hooks.
// ---------------------------------------------------------------------------

interface ItemQuery {
  kind: Kind;
  /** null = every tracked project. */
  project?: string | null;
  state?: "open" | "closed";
}

/**
 * Cached items for one kind. The list view filters what comes back with the
 * panel's own query grammar; the coarse `project`/`state` arguments exist for
 * the surfaces that only ever want one slice (homepage, merge-request picker).
 */
function useItems({ kind, project = null, state }: ItemQuery): {
  items: Item[] | null;
  error: string | null;
  reload: () => void;
} {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [result, setResult] = useState<{
    items: Item[] | null;
    error: string | null;
  }>({ items: null, error: null });
  const reload = useCallback(() => {
    rpc
      .call("listItems", {
        kind,
        ...(project === null ? {} : { project }),
        ...(state === undefined ? {} : { state }),
      })
      .then(
        (value) => setResult({ items: value.items, error: null }),
        (error: unknown) =>
          setResult({ items: null, error: errorText(error) }),
      );
  }, [rpc, kind, project, state]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("data-changed", reload);
  return { ...result, reload };
}

function useStatus(): Status | null {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(() => {
    rpc.call("status").then(
      (value) => setStatus(value),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("data-changed", reload);
  return status;
}

function useLinks(): LinksMap {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [links, setLinks] = useState<LinksMap>({});
  const reload = useCallback(() => {
    rpc.call("listLinks").then(
      (value) => setLinks(value.links),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("links-changed", reload);
  return links;
}

function useSpawn(): {
  spawn: (kind: Kind, project: string, iid: number) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (kind: Kind, project: string, iid: number) => {
      setSpawningKey(linkKey(kind, project, iid));
      rpc
        .call(kind === "mr" ? "startReview" : "startWork", { project, iid })
        .then((result) => navigate.toThread(result.threadId))
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

/** The glab viewer's username, cached at module level — one fetch per load. */
let viewerUsername: string | null = null;

function useViewer(): string | null {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [username, setUsername] = useState<string | null>(viewerUsername);
  useEffect(() => {
    if (viewerUsername !== null) return;
    rpc.call("viewer").then(
      (result) => {
        viewerUsername = result.username;
        setUsername(result.username);
      },
      () => {},
    );
  }, [rpc]);
  return username;
}

function useItemMutations() {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const setIssueState = useCallback(
    (project: string, iid: number, state: "open" | "closed") =>
      rpc
        .call("setIssueState", { project, iid, state })
        .then(() =>
          toast.success(
            state === "closed" ? `#${iid} closed` : `#${iid} reopened`,
          ),
        ),
    [rpc],
  );
  const setAssignees = useCallback(
    (project: string, iid: number, assignees: string[]) =>
      rpc.call("setAssignees", { project, iid, assignees }),
    [rpc],
  );
  const setLabels = useCallback(
    (project: string, iid: number, labels: string[]) =>
      rpc.call("setLabels", { project, iid, labels }),
    [rpc],
  );
  return { setIssueState, setAssignees, setLabels };
}

// ---------------------------------------------------------------------------
// Shared bits.
// ---------------------------------------------------------------------------

/**
 * A username chip. GitLab avatars need an authenticated request on most
 * self-managed instances, so the panel draws initials from the theme's own
 * tokens instead of leaking requests to an instance it can't authenticate to.
 */
function Avatar({
  username,
  size = "size-5",
  className,
}: {
  username: string;
  size?: string;
  className?: string;
}) {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <span
      title={username}
      aria-hidden="true"
      className={`${size} inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium uppercase text-muted-foreground ${className ?? ""}`}
    >
      {initials}
    </span>
  );
}

function UserLine({ username }: { username: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-foreground">
      <Avatar username={username} />
      <span className="min-w-0 truncate">{username}</span>
    </p>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 opacity-50"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

/**
 * GitLab state → a theme-token dot. Draft is a separate boolean on GitLab, so
 * it wins the dot only while the merge request is still open.
 */
function stateDotClass(state: string, draft = false): string {
  if (state === "opened") {
    return draft ? "bg-muted-foreground/60" : "bg-primary";
  }
  if (state === "merged") return "bg-foreground";
  if (state === "locked") return "bg-muted-foreground";
  return "bg-destructive";
}

function StateDot({ state, draft }: { state: string; draft?: boolean }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${stateDotClass(state, draft)}`}
    />
  );
}

function stateLabel(state: string, draft = false): string {
  if (state === "opened") return draft ? "draft" : "open";
  return state;
}

function StateBadge({ state, draft }: { state: string; draft?: boolean }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateDot state={state} draft={draft} />
      {stateLabel(state, draft)}
    </Badge>
  );
}

function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {links.map((link, index) => (
        <Badge
          key={link.threadId}
          title={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          variant="secondary"
          className="cursor-pointer whitespace-nowrap hover:bg-accent"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </Badge>
      ))}
    </span>
  );
}

function LabelChips({
  labels,
  className,
}: {
  labels: string[];
  className?: string;
}) {
  if (labels.length === 0) return null;
  return (
    <span className={`items-center gap-1 ${className ?? "flex shrink-0"}`}>
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label}
          variant="secondary"
          className="font-normal text-muted-foreground"
        >
          {label}
        </Badge>
      ))}
    </span>
  );
}

function SidebarHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function NoteCard({ note }: { note: Note }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <Avatar username={note.author} />
        <span className="font-medium text-foreground">{note.author}</span> ·{" "}
        {relativeTime(note.createdAt)}
      </p>
      <Markdown content={note.body} className="text-sm" />
    </div>
  );
}

function CommentBox({
  method,
  project,
  iid,
  onPosted,
}: {
  method: "commentIssue" | "commentMergeRequest";
  project: string;
  iid: number;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (body.trim().length === 0) return;
    setPosting(true);
    rpc
      .call(method, { project, iid, body })
      .then(() => {
        setBody("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, method, project, iid, body, onPosted]);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a comment…"
        aria-label="New comment"
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={posting || body.trim().length === 0}
          onClick={post}
        >
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The filter bar: one query box — qualifiers (`is:`, `assignee:`, `author:`,
// `label:`, `project:`, `no:`) plus plain text — with a keyboard-driven
// completion list built from the loaded items.
// ---------------------------------------------------------------------------

function SuggestionIcon({ suggestion }: { suggestion: QuerySuggestion }) {
  if (suggestion.state !== undefined) {
    return <StateDot state={suggestion.state} draft={suggestion.draft} />;
  }
  if (suggestion.username !== undefined) {
    return <Avatar username={suggestion.username} size="size-4" />;
  }
  return null;
}

function FilterBar({
  kind,
  projects,
  items,
  value,
  onChange,
}: {
  kind: Kind;
  projects: ProjectInfo[];
  items: Item[] | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const viewer = useViewer();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [highlight, setHighlight] = useState(0);

  const vocab = useMemo<QueryVocabulary>(() => {
    const users = new Set<string>();
    const labels = new Set<string>();
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const username of item.assignees) users.add(username);
      for (const username of item.reviewers) users.add(username);
      for (const label of item.labels) labels.add(label);
    }
    return {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      projects: projects.map((entry) => entry.project),
    };
  }, [items, projects]);

  // The token under the caret is what gets completed, so a qualifier can be
  // fixed mid-query instead of only at the end.
  const upToCaret = value.slice(0, caret);
  const tokenStart = upToCaret.lastIndexOf(" ") + 1;
  const token = upToCaret.slice(tokenStart);
  const suggestions = useMemo(
    () => suggestQueryTokens(token, vocab, kind, viewer).slice(0, 8),
    [token, vocab, kind, viewer],
  );
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const accept = (suggestion: QuerySuggestion) => {
    onChange(value.slice(0, tokenStart) + suggestion.insert + value.slice(caret));
    const position = tokenStart + suggestion.insert.length;
    setCaret(position);
    setHighlight(0);
    // The re-render owns the value, so the caret can only be placed after it.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || suggestions.length === 0) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((active + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((active - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[active]);
    }
  };

  const listOpen = open && suggestions.length > 0;
  const noun = kind === "mr" ? "merge requests" : "issues";
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(0);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={() =>
          setCaret(inputRef.current?.selectionStart ?? value.length)
        }
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="Filter — is:open assignee:@me label:bug, or plain text"
        aria-label={`Filter ${noun}`}
        role="combobox"
        aria-expanded={listOpen}
        aria-autocomplete="list"
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen ? `${listId}-${active}` : undefined}
        className="h-9 pr-8 text-sm"
        spellCheck={false}
      />
      {value.length > 0 ? (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => {
            // mousedown, not click: blurring the input would close the list
            // before the clear ever lands.
            event.preventDefault();
            onChange("");
            setCaret(0);
            inputRef.current?.focus();
          }}
          aria-label="Clear filter"
        >
          ✕
        </button>
      ) : null}
      {listOpen ? (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                index === active
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <SuggestionIcon suggestion={suggestion} />
              <span className="min-w-0 truncate font-medium">
                {suggestion.label}
              </span>
              {suggestion.hint !== undefined ? (
                <span className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
                  {suggestion.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list.
// ---------------------------------------------------------------------------

// Shared column widths so the header row lines up with item rows. The list
// switches modes against its own width, not the browser viewport.
const COL = {
  id: "shrink-0 @[48rem]:w-14",
  assignee: "shrink-0 @[48rem]:w-20",
  status: "shrink-0 @[48rem]:w-24",
  updated: "hidden w-14 shrink-0 text-right @[48rem]:block",
  actions:
    "ml-auto flex shrink-0 items-center justify-end gap-1 @[48rem]:ml-0 @[48rem]:w-28",
} as const;

function AssigneeCell({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <span
      className="flex items-center -space-x-1.5"
      title={assignees.join(", ")}
    >
      {assignees.slice(0, 3).map((username) => (
        <Avatar key={username} username={username} className="ring-1 ring-card" />
      ))}
      {assignees.length > 3 ? (
        <span className="pl-2.5 text-xs text-muted-foreground">
          +{assignees.length - 3}
        </span>
      ) : null}
    </span>
  );
}

/** Inline state control: a dropdown for issues, a badge for merge requests. */
function StatusCell({ item }: { item: Item }) {
  const { setIssueState } = useItemMutations();
  const [pending, setPending] = useState(false);
  if (item.kind === "mr") {
    return <StateBadge state={item.state} draft={item.draft} />;
  }
  const change = (next: "open" | "closed") => {
    if ((item.state === "opened") === (next === "open")) return;
    setPending(true);
    setIssueState(item.project, item.iid, next)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs font-normal"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Change issue #${item.iid} state, currently ${stateLabel(item.state)}`}
          aria-busy={pending}
        >
          <StateDot state={item.state} />
          <span>{pending ? "…" : stateLabel(item.state)}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => change("open")}>
          <StateDot state="opened" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => change("closed")}>
          <StateDot state="closed" />
          Closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({ item }: { item: Item }) {
  const viewer = useViewer();
  const { setIssueState, setAssignees } = useItemMutations();
  const assignedToMe = viewer !== null && item.assignees.includes(viewer);
  const ref = `${MARKER[item.kind]}${item.iid}`;

  const toggleSelfAssign = () => {
    if (viewer === null) return;
    const next = assignedToMe
      ? item.assignees.filter((username) => username !== viewer)
      : [...item.assignees, viewer];
    setAssignees(item.project, item.iid, next)
      .then(() =>
        toast.success(
          assignedToMe ? `Unassigned from ${ref}` : `Assigned to ${ref}`,
        ),
      )
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          aria-label={`More actions for ${ref}`}
          onClick={(event) => event.stopPropagation()}
        >
          ⋮
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.kind === "issue" && viewer !== null ? (
          <DropdownMenuItem onSelect={toggleSelfAssign}>
            {assignedToMe ? "Unassign me" : "Assign to me"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? (
          <DropdownMenuItem
            onSelect={() =>
              setIssueState(
                item.project,
                item.iid,
                item.state === "opened" ? "closed" : "open",
              ).catch((error: unknown) => toast.error(errorText(error)))
            }
          >
            {item.state === "opened" ? "Close issue" : "Reopen issue"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => window.open(item.url, "_blank")}>
          Open on GitLab ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(item.url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  links,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  onOpen: () => void;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === linkKey(item.kind, item.project, item.iid);
  return (
    <div
      className="grid cursor-pointer grid-cols-1 gap-y-2 px-3 py-3 hover:bg-accent/50 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3 @[48rem]:py-2"
      onClick={onOpen}
    >
      <span className="flex min-w-0 flex-col items-start gap-1.5 @[48rem]:order-2 @[48rem]:flex-1 @[48rem]:flex-row @[48rem]:items-center @[48rem]:gap-2">
        <span className="min-w-0 flex-1 line-clamp-3 text-sm font-medium leading-snug text-foreground @[48rem]:line-clamp-1 @[48rem]:leading-normal">
          {item.title}
        </span>
        <span
          className="shrink-0 truncate text-xs text-muted-foreground"
          title={item.project}
        >
          {shortProject(item.project)}
        </span>
        <LabelChips
          labels={item.labels}
          className="hidden shrink-0 @[60rem]:flex"
        />
        <ThreadPills links={links} />
      </span>
      <span className="flex min-w-0 items-center gap-2 @[48rem]:contents">
        <span
          className={`${COL.id} font-mono text-xs text-muted-foreground @[48rem]:order-1`}
        >
          {MARKER[item.kind]}
          {item.iid}
        </span>
        <span
          className={`${COL.assignee} ${item.assignees.length === 0 ? "hidden @[48rem]:flex" : "flex"} items-center gap-1 text-xs text-muted-foreground @[48rem]:order-3`}
          title={`opened by ${item.author}`}
        >
          <AssigneeCell assignees={item.assignees} />
        </span>
        <span className={`${COL.status} @[48rem]:order-4`}>
          <StatusCell item={item} />
        </span>
        <span
          className={`${COL.updated} text-xs text-muted-foreground @[48rem]:order-5`}
        >
          {relativeTime(item.updatedAt)}
        </span>
        <span className={`${COL.actions} @[48rem]:order-6`}>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={spawningKey !== null}
            aria-label={
              item.kind === "issue"
                ? `Send agent to issue #${item.iid}`
                : `Review merge request !${item.iid} with an agent`
            }
            onClick={(event) => {
              event.stopPropagation();
              spawn(item.kind, item.project, item.iid);
            }}
          >
            {busy ? "…" : item.kind === "issue" ? "Send agent" : "Review"}
          </Button>
          <RowMenu item={item} />
        </span>
      </span>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="grid grid-cols-1 gap-y-3 px-3 py-3 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3"
        >
          <Skeleton className="h-3 w-4/5 @[48rem]:order-2 @[48rem]:flex-1" />
          <span className="flex items-center gap-2 @[48rem]:contents">
            <span className={`${COL.id} @[48rem]:order-1`}>
              <Skeleton className="h-3 w-10" />
            </span>
            <span className={`${COL.assignee} flex @[48rem]:order-3`}>
              <Skeleton className="size-5 rounded-full @[48rem]:h-3 @[48rem]:w-16" />
            </span>
            <span className={`${COL.status} @[48rem]:order-4`}>
              <Skeleton className="h-3 w-16" />
            </span>
            <span className={`${COL.updated} @[48rem]:order-5`}>
              <Skeleton className="ml-auto h-3 w-12" />
            </span>
            <span className={`${COL.actions} @[48rem]:order-6`}>
              <Skeleton className="h-7 w-24" />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ItemsList({
  kind,
  items,
  error,
  hasFilter,
  onOpenItem,
}: {
  kind: Kind;
  items: Item[] | null;
  error: string | null;
  hasFilter: boolean;
  onOpenItem: (project: string, iid: number) => void;
}) {
  const links = useLinks();
  const noun = kind === "mr" ? "merge requests" : "issues";

  let body: React.ReactNode;
  if (error !== null) {
    body = <EmptyState message={error} />;
  } else if (items === null) {
    body = <ListSkeleton />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        message={
          hasFilter
            ? `No ${noun} match this filter.`
            : `No ${noun} in the tracked projects.`
        }
      />
    );
  } else {
    body = (
      <div className="divide-y divide-border">
        {items.map((item) => (
          <ItemRow
            key={linkKey(item.kind, item.project, item.iid)}
            item={item}
            links={links[linkKey(kind, item.project, item.iid)]}
            onOpen={() => onOpenItem(item.project, item.iid)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="@container overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:flex">
        <span className={COL.id}>{kind === "mr" ? "MR" : "Issue"}</span>
        <span className="min-w-0 flex-1">Title</span>
        <span className={COL.assignee}>Assignees</span>
        <span className={COL.status}>State</span>
        <span className={COL.updated}>Updated</span>
        <span className={COL.actions} />
      </div>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pickers shared by the issue detail view.
// ---------------------------------------------------------------------------

function AssigneePicker({
  project,
  assignees,
  onToggle,
  label = "Assignees",
}: {
  project: string;
  /** The users currently picked — assignees, or reviewers with `label`. */
  assignees: string[];
  onToggle: (username: string, assigned: boolean) => void;
  label?: string;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const viewer = useViewer();
  const [users, setUsers] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (users !== null) return;
    rpc.call("assignableUsers", { project }).then(
      (result) => setUsers(result.users),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, project, users]);

  // The viewer floats to the top of the picker.
  const ordered =
    users === null
      ? null
      : [...users].sort((a, b) => Number(b === viewer) - Number(a === viewer));

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No assignable users</DropdownMenuItem>
        ) : (
          ordered.map((username) => (
            <DropdownMenuCheckboxItem
              key={username}
              checked={assignees.includes(username)}
              onCheckedChange={(checked) => onToggle(username, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar username={username} size="size-4" />
                <span className="truncate">
                  {username}
                  {username === viewer ? " (you)" : ""}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelPicker({
  project,
  labels,
  onToggle,
}: {
  project: string;
  labels: string[];
  onToggle: (label: string, enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (available !== null) return;
    rpc.call("projectLabels", { project }).then(
      (result) => setAvailable(result.labels),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, project, available]);

  const ordered =
    available === null
      ? null
      : [...new Set([...labels, ...available])].sort((a, b) =>
          a.localeCompare(b),
        );

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          aria-label="Edit labels"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No labels in this project</DropdownMenuItem>
        ) : (
          ordered.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 truncate">{label}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Issue detail: body + notes on the left, metadata sidebar on the right.
// ---------------------------------------------------------------------------

function IssueDetailView({
  project,
  iid,
  onBack,
}: {
  project: string;
  iid: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const { setIssueState, setAssignees, setLabels } = useItemMutations();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getIssue", { project, iid }).then(
      (result) => {
        setDetail(result.issue);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  const changeState = useCallback(
    (next: "open" | "closed") => {
      setDetail((prev) =>
        prev === null
          ? prev
          : { ...prev, state: next === "closed" ? "closed" : "opened" },
      );
      setIssueState(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setIssueState, project, iid, load],
  );

  const toggleAssignee = useCallback(
    (username: string, assigned: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = assigned
          ? [...new Set([...prev.assignees, username])]
          : prev.assignees.filter((entry) => entry !== username);
        return { ...prev, assignees: next };
      });
      setAssignees(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, project, iid, load],
  );

  const toggleLabel = useCallback(
    (label: string, enabled: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = enabled
          ? [...new Set([...prev.labels, label])]
          : prev.labels.filter((entry) => entry !== label);
        return { ...prev, labels: next };
      });
      setLabels(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, project, iid, load],
  );

  if (error !== null) return <EmptyState message={error} />;
  if (detail === null) return <DetailSkeleton />;

  const issueLinks = links[linkKey("issue", project, iid)];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
          ← Issues
        </Button>
        <span className="min-w-0 truncate">
          {project} · #{iid}
        </span>
        <span className="flex-1" />
        <a
          href={detail.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 underline hover:text-foreground"
        >
          Open on GitLab ↗
        </a>
      </div>

      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
          {detail.title}{" "}
          <span className="font-normal text-muted-foreground">#{detail.iid}</span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("issue", project, iid)}
        >
          {spawningKey !== null ? "Starting…" : "Send agent"}
        </Button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              <Avatar username={detail.author} />
              <span className="font-medium text-foreground">
                {detail.author}
              </span>
              opened this issue · updated {relativeTime(detail.updatedAt)}
            </div>
            <div className="p-4">
              {detail.body.length > 0 ? (
                <Markdown content={detail.body} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  (no description)
                </p>
              )}
            </div>
          </div>

          {detail.notes.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Activity · {detail.notes.length}
              </h3>
              {detail.notes.map((note, index) => (
                <NoteCard key={index} note={note} />
              ))}
            </div>
          ) : null}

          <CommentBox
            method="commentIssue"
            project={project}
            iid={iid}
            onPosted={load}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
          <div className="flex flex-col gap-2">
            <SidebarHeading>State</SidebarHeading>
            <Select
              value={detail.state === "opened" ? "open" : "closed"}
              onValueChange={(value) =>
                changeState(value === "closed" ? "closed" : "open")
              }
            >
              <SelectTrigger className="h-8 w-full text-sm" aria-label="State">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  <span className="flex items-center gap-2">
                    <StateDot state="opened" /> Open
                  </span>
                </SelectItem>
                <SelectItem value="closed">
                  <span className="flex items-center gap-2">
                    <StateDot state="closed" /> Closed
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <SidebarHeading>Assignees</SidebarHeading>
              <AssigneePicker
                project={project}
                assignees={detail.assignees}
                onToggle={toggleAssignee}
              />
            </div>
            {detail.assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one assigned</p>
            ) : (
              detail.assignees.map((username) => (
                <UserLine key={username} username={username} />
              ))
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SidebarHeading>Labels</SidebarHeading>
              <LabelPicker
                project={project}
                labels={detail.labels}
                onToggle={toggleLabel}
              />
            </div>
            {detail.labels.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet</p>
            ) : (
              <LabelChips labels={detail.labels} className="flex flex-wrap" />
            )}
          </div>

          {issueLinks !== undefined && issueLinks.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Agents</SidebarHeading>
              <ThreadPills links={issueLinks} />
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge-request detail — the merge box (approvals, pipeline, merge: the
// actions GitLab's own merge widget offers), reviewers and assignees, the
// activity timeline, and diffs. One component serves both the nav panel
// (two-column, metadata sidebar) and the thread side panel (single column via
// `compact`).
// ---------------------------------------------------------------------------

/** Pipeline statuses that are still moving. */
const PIPELINE_ACTIVE = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);
/** Merge statuses that mean GitLab has not decided yet. */
const MERGE_CHECKING = new Set([
  "checking",
  "unchecked",
  "preparing",
  "approvals_syncing",
]);

function jobDotClass(status: Job["status"]): string {
  if (status === "success") return "bg-primary";
  if (status === "failure") return "bg-destructive";
  if (status === "warning") return "bg-amber-500";
  if (status === "pending") return "animate-pulse bg-muted-foreground";
  return "bg-muted-foreground/50";
}

function pipelineDotClass(status: string): string {
  if (status === "success") return "bg-primary";
  if (status === "failed") return "bg-destructive";
  if (PIPELINE_ACTIVE.has(status)) return "animate-pulse bg-muted-foreground";
  return "bg-muted-foreground/50";
}

/**
 * GitLab's detailed_merge_status in plain words, and whether it is a state
 * the viewer can act on now ("ready"), must wait for ("waiting"), or must fix
 * first ("blocked").
 */
function mergeReadiness(status: string): {
  text: string;
  tone: "ready" | "waiting" | "blocked";
} {
  switch (status) {
    case "mergeable":
      return { text: "Ready to merge", tone: "ready" };
    case "ci_still_running":
      return { text: "Waiting for the pipeline to finish", tone: "waiting" };
    case "ci_must_pass":
      return { text: "The pipeline must pass first", tone: "blocked" };
    case "discussions_not_resolved":
      return { text: "All threads must be resolved first", tone: "blocked" };
    case "draft_status":
      return {
        text: "This is a draft. Mark it as ready on GitLab first",
        tone: "blocked",
      };
    case "need_rebase":
      return {
        text: "The source branch must be rebased onto the target",
        tone: "blocked",
      };
    case "not_approved":
      return { text: "It needs approval first", tone: "blocked" };
    case "requested_changes":
      return { text: "A reviewer requested changes", tone: "blocked" };
    case "conflict":
      return { text: "There are merge conflicts", tone: "blocked" };
    case "blocked_status":
    case "merge_request_blocked":
      return {
        text: "Another merge request must be merged first",
        tone: "blocked",
      };
    case "security_policy_violations":
      return { text: "A security policy blocks the merge", tone: "blocked" };
    case "jira_association_missing":
      return {
        text: "The title or description needs a Jira issue key",
        tone: "blocked",
      };
    case "external_status_checks":
    case "status_checks_must_pass":
      return { text: "External status checks must pass", tone: "blocked" };
    case "commits_status":
      return {
        text: "The source branch has no commits or no longer exists",
        tone: "blocked",
      };
    case "locked_paths":
    case "locked_lfs_files":
      return { text: "Locked files block the merge", tone: "blocked" };
    case "title_regex":
      return {
        text: "The title does not match the required pattern",
        tone: "blocked",
      };
    case "not_open":
      return { text: "It is not open", tone: "blocked" };
    default:
      if (MERGE_CHECKING.has(status)) {
        return {
          text: "GitLab is checking if it can be merged…",
          tone: "waiting",
        };
      }
      return { text: status.replace(/_/g, " "), tone: "blocked" };
  }
}

/**
 * Runs one merge-request action at a time: `busy` names the running one so
 * its button can say so, a failure becomes a toast, and a success reloads.
 */
function useMergeRequestAction(onDone: () => void): {
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>, success: string) => void;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    (key: string, action: () => Promise<unknown>, success: string) => {
      setBusy(key);
      action()
        .then(() => {
          toast.success(success);
          onDone();
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setBusy(null));
    },
    [onDone],
  );
  return { busy, run };
}

function WidgetRow({
  dot,
  children,
  actions,
}: {
  dot: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      {actions !== undefined ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalRow({
  mr,
  busy,
  run,
}: {
  mr: MergeRequestDetail;
  busy: string | null;
  run: ReturnType<typeof useMergeRequestAction>["run"];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const approved = Math.max(0, mr.approvalsRequired - mr.approvalsLeft);
  const summary =
    mr.approvalsRequired === 0
      ? mr.approvedBy.length > 0
        ? "Approved · none required"
        : "No approval required"
      : mr.approvalsLeft === 0
        ? `Approved · ${approved} of ${mr.approvalsRequired}`
        : `${approved} of ${mr.approvalsRequired} approvals · needs ${mr.approvalsLeft} more`;
  const dot =
    mr.approvalsRequired > 0 && mr.approvalsLeft > 0
      ? "bg-muted-foreground/50"
      : "bg-primary";
  const open = mr.state === "opened";
  const setApproval = (next: boolean) =>
    run(
      "approve",
      () =>
        rpc.call("setApproval", {
          project: mr.project,
          iid: mr.iid,
          approved: next,
          sha: mr.sha,
        }),
      next ? `Approved !${mr.iid}` : `Approval revoked on !${mr.iid}`,
    );
  return (
    <WidgetRow
      dot={dot}
      actions={
        open && mr.userHasApproved ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setApproval(false)}
          >
            {busy === "approve" ? "Revoking…" : "Revoke approval"}
          </Button>
        ) : open && mr.userCanApprove ? (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => setApproval(true)}
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </Button>
        ) : undefined
      }
    >
      <span className="text-foreground">{summary}</span>
      {mr.approvedBy.length > 0 ? (
        <span className="text-muted-foreground">
          {" "}
          · by {mr.approvedBy.join(", ")}
        </span>
      ) : null}
    </WidgetRow>
  );
}

function jobCounts(jobs: Job[]): string {
  const count = (status: Job["status"]) =>
    jobs.filter((job) => job.status === status).length;
  const parts = [
    [count("failure"), "failed"],
    [count("warning"), "allowed to fail"],
    [count("pending"), "running"],
    [jobs.filter((job) => job.rawStatus === "manual").length, "manual"],
    [count("success"), "passed"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

function JobRow({
  job,
  project,
  busy,
  run,
}: {
  job: Job;
  project: string;
  busy: string | null;
  run: ReturnType<typeof useMergeRequestAction>["run"];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const act = (action: "play" | "retry" | "cancel", success: string) =>
    run(
      `job-${job.id}`,
      () => rpc.call("jobAction", { project, jobId: job.id, action }),
      success,
    );
  const running = busy === `job-${job.id}`;
  const action =
    job.rawStatus === "manual"
      ? { label: "Run", onClick: () => act("play", `Started ${job.name}`) }
      : job.rawStatus === "failed" || job.rawStatus === "canceled"
        ? { label: "Retry", onClick: () => act("retry", `Retrying ${job.name}`) }
        : PIPELINE_ACTIVE.has(job.rawStatus)
          ? {
              label: "Cancel",
              onClick: () => act("cancel", `Canceled ${job.name}`),
            }
          : null;
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      <span
        className={`size-2 shrink-0 rounded-full ${jobDotClass(job.status)}`}
      />
      <span className="min-w-0 flex-1 truncate text-foreground" title={job.name}>
        {job.name}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {job.status === "warning" ? "failed (allowed)" : job.rawStatus}
      </span>
      {action !== null ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={busy !== null}
          onClick={action.onClick}
        >
          {running ? "…" : action.label}
        </Button>
      ) : null}
      {job.url.length > 0 ? (
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground underline hover:text-foreground"
          title="Open the job log on GitLab"
        >
          log ↗
        </a>
      ) : null}
    </div>
  );
}

function PipelineRow({
  mr,
  busy,
  run,
}: {
  mr: MergeRequestDetail;
  busy: string | null;
  run: ReturnType<typeof useMergeRequestAction>["run"];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const { pipeline, jobs } = mr;
  const [open, setOpen] = useState(() =>
    jobs.some((job) => job.status === "failure" || job.rawStatus === "manual"),
  );
  const stages = useMemo(() => {
    const byStage = new Map<string, Job[]>();
    for (const job of jobs) {
      const list = byStage.get(job.stage);
      if (list === undefined) byStage.set(job.stage, [job]);
      else list.push(job);
    }
    return [...byStage.entries()];
  }, [jobs]);
  const isOpen = mr.state === "opened";
  const active = pipeline !== null && PIPELINE_ACTIVE.has(pipeline.status);
  const canRetry =
    pipeline !== null &&
    !active &&
    (pipeline.status === "failed" ||
      pipeline.status === "canceled" ||
      jobs.some((job) => job.status === "failure"));

  const actions = (
    <>
      {isOpen ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run(
              "run-pipeline",
              () =>
                rpc.call("runPipeline", { project: mr.project, iid: mr.iid }),
              "Pipeline started",
            )
          }
        >
          {busy === "run-pipeline" ? "Starting…" : "Run pipeline"}
        </Button>
      ) : null}
      {pipeline !== null && canRetry ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run(
              "retry-pipeline",
              () =>
                rpc.call("pipelineAction", {
                  project: mr.project,
                  pipelineId: pipeline.id,
                  action: "retry",
                }),
              "Retrying failed jobs",
            )
          }
        >
          {busy === "retry-pipeline" ? "Retrying…" : "Retry failed"}
        </Button>
      ) : null}
      {pipeline !== null && active ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() =>
            run(
              "cancel-pipeline",
              () =>
                rpc.call("pipelineAction", {
                  project: mr.project,
                  pipelineId: pipeline.id,
                  action: "cancel",
                }),
              "Pipeline canceled",
            )
          }
        >
          {busy === "cancel-pipeline" ? "Canceling…" : "Cancel"}
        </Button>
      ) : null}
    </>
  );

  return (
    <div>
      <WidgetRow
        dot={
          pipeline === null
            ? "bg-muted-foreground/50"
            : pipelineDotClass(pipeline.status)
        }
        actions={actions}
      >
        {pipeline === null ? (
          <span className="text-muted-foreground">No pipeline yet</span>
        ) : (
          <button
            className="flex min-w-0 max-w-full items-center gap-1.5 text-left"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            disabled={jobs.length === 0}
          >
            <span className="font-medium text-foreground">
              Pipeline {pipeline.status}
            </span>
            {jobs.length > 0 ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {jobCounts(jobs)}
              </span>
            ) : null}
            {jobs.length > 0 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {open ? "▾" : "▸"}
              </span>
            ) : null}
          </button>
        )}
      </WidgetRow>
      {open && pipeline !== null ? (
        <div className="border-t border-border bg-muted/20 py-1">
          {stages.map(([stage, stageJobs]) => (
            <div key={stage} className="py-0.5">
              {stages.length > 1 && stage.length > 0 ? (
                <p className="px-3 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {stage}
                </p>
              ) : null}
              {stageJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  project={mr.project}
                  busy={busy}
                  run={run}
                />
              ))}
            </div>
          ))}
          {pipeline.url.length > 0 ? (
            <p className="px-3 pt-1 text-xs">
              <a
                href={pipeline.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline hover:text-foreground"
              >
                Pipeline #{pipeline.id} on GitLab ↗
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MergeRow({
  mr,
  busy,
  run,
}: {
  mr: MergeRequestDetail;
  busy: string | null;
  run: ReturnType<typeof useMergeRequestAction>["run"];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [squash, setSquash] = useState(mr.squash);
  const [removeSourceBranch, setRemoveSourceBranch] = useState(
    mr.removeSourceBranch,
  );
  const [confirming, setConfirming] = useState<"merge" | "auto" | null>(null);
  // A reload after another action brings fresh defaults; keep them in step
  // unless the viewer is in the middle of confirming.
  useEffect(() => {
    if (confirming === null) {
      setSquash(mr.squash);
      setRemoveSourceBranch(mr.removeSourceBranch);
    }
  }, [mr.squash, mr.removeSourceBranch]);

  if (mr.state === "merged") {
    return (
      <WidgetRow dot="bg-primary">
        <span className="font-medium text-foreground">Merged</span>
      </WidgetRow>
    );
  }
  if (mr.state !== "opened") {
    return (
      <WidgetRow dot="bg-muted-foreground/50">
        <span className="text-muted-foreground">
          This merge request is {mr.state}.
        </span>
      </WidgetRow>
    );
  }

  const readiness = mergeReadiness(mr.mergeStatus);
  const pipelineActive =
    mr.pipeline !== null && PIPELINE_ACTIVE.has(mr.pipeline.status);
  // As on GitLab: while a pipeline runs, waiting for it comes first, even in
  // a project that would allow merging right away ("mergeable"). If the
  // pipeline has already passed when the request lands, GitLab merges now.
  const canAutoMerge =
    pipelineActive &&
    (mr.mergeStatus === "ci_still_running" ||
      mr.mergeStatus === "ci_must_pass" ||
      mr.mergeStatus === "mergeable");
  const squashLocked =
    mr.squashOption === "always" || mr.squashOption === "never";
  const dot =
    readiness.tone === "ready"
      ? "bg-primary"
      : readiness.tone === "waiting"
        ? "animate-pulse bg-muted-foreground"
        : "bg-destructive";

  const merge = (autoMerge: boolean) => {
    setConfirming(null);
    run(
      "merge",
      () =>
        rpc.call("mergeMergeRequest", {
          project: mr.project,
          iid: mr.iid,
          sha: mr.sha,
          squash,
          removeSourceBranch,
          autoMerge,
        }),
      autoMerge
        ? `!${mr.iid} will merge when the pipeline succeeds`
        : `Merged !${mr.iid}`,
    );
  };

  let actions: React.ReactNode;
  if (mr.autoMerge) {
    actions = (
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() =>
          run(
            "cancel-auto-merge",
            () =>
              rpc.call("cancelAutoMerge", { project: mr.project, iid: mr.iid }),
            "Auto-merge canceled",
          )
        }
      >
        {busy === "cancel-auto-merge" ? "Canceling…" : "Cancel auto-merge"}
      </Button>
    );
  } else if (mr.canMerge) {
    actions = (
      <>
        {mr.mergeStatus === "need_rebase" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run(
                "rebase",
                () =>
                  rpc.call("rebaseMergeRequest", {
                    project: mr.project,
                    iid: mr.iid,
                  }),
                "Rebase started",
              )
            }
          >
            {busy === "rebase" ? "Starting…" : "Rebase"}
          </Button>
        ) : null}
        {canAutoMerge ? (
          <>
            {mr.mergeStatus === "mergeable" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => setConfirming("merge")}
              >
                Merge now
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirming("auto")}
            >
              {busy === "merge" ? "Setting…" : "Set to auto-merge"}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null || mr.mergeStatus !== "mergeable"}
            onClick={() => setConfirming("merge")}
          >
            {busy === "merge" ? "Merging…" : "Merge"}
          </Button>
        )}
      </>
    );
  }

  return (
    <div>
      <WidgetRow dot={dot} actions={actions}>
        <span className="text-foreground">
          {mr.autoMerge
            ? "Set to merge when the pipeline succeeds"
            : readiness.text}
        </span>
        {!mr.canMerge && !mr.autoMerge ? (
          <span className="text-muted-foreground">
            {" "}
            · you cannot merge this
          </span>
        ) : null}
      </WidgetRow>
      {mr.mergeError !== null ? (
        <p className="px-3 pb-2 pl-7 text-xs text-destructive">
          Last merge attempt failed: {mr.mergeError}
        </p>
      ) : null}
      {mr.canMerge && !mr.autoMerge ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-2 pl-7 text-xs text-muted-foreground">
          <label
            className="flex items-center gap-1.5"
            title={
              squashLocked
                ? `The project ${mr.squashOption === "always" ? "always" : "never"} squashes commits`
                : undefined
            }
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={squash}
              disabled={squashLocked || busy !== null}
              onChange={(event) => setSquash(event.target.checked)}
            />
            Squash commits
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-primary"
              checked={removeSourceBranch}
              disabled={busy !== null}
              onChange={(event) => setRemoveSourceBranch(event.target.checked)}
            />
            Delete source branch
          </label>
        </div>
      ) : null}
      <Dialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirming === "auto"
                ? `Merge !${mr.iid} when the pipeline succeeds?`
                : `Merge !${mr.iid}?`}
            </DialogTitle>
            <DialogDescription>{mr.title}</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1 text-sm text-foreground">
            <li className="font-mono text-xs">
              {mr.sourceBranch} → {mr.targetBranch}
            </li>
            <li>
              {squash
                ? "Commits will be squashed"
                : "Commits will not be squashed"}
            </li>
            <li>
              {removeSourceBranch
                ? "The source branch will be deleted"
                : "The source branch will be kept"}
            </li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button onClick={() => merge(confirming === "auto")}>
              {confirming === "auto" ? "Set to auto-merge" : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MergeWidget({
  mr,
  onChanged,
}: {
  mr: MergeRequestDetail;
  onChanged: () => void;
}) {
  const { busy, run } = useMergeRequestAction(onChanged);
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      <ApprovalRow mr={mr} busy={busy} run={run} />
      <PipelineRow mr={mr} busy={busy} run={run} />
      <MergeRow mr={mr} busy={busy} run={run} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewers and assignees, editable in both the page and the side panel.
// ---------------------------------------------------------------------------

function PeopleList({
  label,
  empty,
  project,
  users,
  onChange,
}: {
  label: string;
  empty: string;
  project: string;
  users: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <SidebarHeading>{label}</SidebarHeading>
        <AssigneePicker
          project={project}
          assignees={users}
          label={label}
          onToggle={(username, picked) =>
            onChange(
              picked
                ? [...new Set([...users, username])]
                : users.filter((entry) => entry !== username),
            )
          }
        />
      </div>
      {users.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        users.map((username) => <UserLine key={username} username={username} />)
      )}
    </div>
  );
}

function PeopleSection({
  mr,
  onPeople,
  className,
}: {
  mr: MergeRequestDetail;
  /** Local update first, then the server's own answer (or a reload). */
  onPeople: (people: { reviewers?: string[]; assignees?: string[] }) => void;
  className?: string;
}) {
  return (
    <div className={className ?? "flex flex-col gap-5"}>
      <PeopleList
        label="Reviewers"
        empty="No reviewers"
        project={mr.project}
        users={mr.reviewers}
        onChange={(reviewers) => onPeople({ reviewers })}
      />
      <PeopleList
        label="Assignees"
        empty="No one assigned"
        project={mr.project}
        users={mr.assignees}
        onChange={(assignees) => onPeople({ assignees })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity: GitLab's discussions as one timeline. Events are one line each,
// a lone comment is a card, and a thread keeps its replies under it, with
// the code it is about, a reply box, and resolve.
// ---------------------------------------------------------------------------

type ActivityFilter = "all" | "comments" | "unresolved";
const ACTIVITY_FILTER_KEY = "bb-plugin-gitlab:activity-filter";

function readActivityFilter(): ActivityFilter {
  try {
    const saved = localStorage.getItem(ACTIVITY_FILTER_KEY);
    return saved === "comments" || saved === "unresolved" ? saved : "all";
  } catch {
    return "all";
  }
}

/** The first line of a system note as plain text: links and tags dropped. */
function eventText(body: string): string {
  const first =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return first
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "");
}

interface Snippet {
  startLine: number;
  lines: string[];
}

// A commit's copy of a file never changes, so snippets are cached for the
// life of the page and shared by every thread on the same lines.
const snippetCache = new Map<string, Promise<Snippet>>();

function DiffSnippet({
  project,
  position,
}: {
  project: string;
  position: DiffPosition;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ref, path, line, endLine } = position;
  useEffect(() => {
    if (ref === null || line === null) return;
    const last = endLine ?? line;
    const key = `${project}|${ref}|${path}|${line}|${last}`;
    let request = snippetCache.get(key);
    if (request === undefined) {
      request = rpc.call("getDiffSnippet", {
        project,
        ref,
        path,
        line,
        endLine: last,
      });
      snippetCache.set(key, request);
      request.catch(() => snippetCache.delete(key));
    }
    let cancelled = false;
    request.then(
      (result) => {
        if (!cancelled) setSnippet(result);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, project, ref, path, line, endLine]);

  if (ref === null || line === null) return null;
  if (error !== null) {
    return (
      <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        Could not load the code: {error}
      </p>
    );
  }
  if (snippet === null) {
    return (
      <div className="border-b border-border px-3 py-2">
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  const last = endLine ?? line;
  const hit =
    position.side === "old" ? "bg-destructive/10" : "bg-primary/10";
  return (
    <div className="overflow-x-auto border-b border-border bg-muted/30 py-1 font-mono text-xs leading-5">
      {snippet.lines.map((text, index) => {
        const number = snippet.startLine + index;
        const marked = number >= line && number <= last;
        return (
          <div key={number} className={`flex min-w-max ${marked ? hit : ""}`}>
            <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground">
              {number}
            </span>
            <span className="whitespace-pre pr-3 text-foreground/90">
              {text.length > 0 ? text : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReplyBox({
  onSubmit,
  placeholder = "Reply…",
}: {
  onSubmit: (body: string) => Promise<void>;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const submit = () => {
    if (body.trim().length === 0 || posting) return;
    setPosting(true);
    onSubmit(body)
      .then(() => {
        setBody("");
        setOpen(false);
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  };
  if (!open) {
    return (
      <button
        className="w-full rounded-md border border-border px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/50"
        onClick={() => setOpen(true)}
      >
        {placeholder}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Write a reply… (Ctrl+Enter to send)"
        aria-label="Reply"
        rows={3}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={posting}
          onClick={() => {
            setOpen(false);
            setBody("");
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={posting || body.trim().length === 0}
          onClick={submit}
        >
          {posting ? "Sending…" : "Reply"}
        </Button>
      </div>
    </div>
  );
}

function NoteBody({ note }: { note: TimelineNote }) {
  if (note.system) {
    return (
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">{note.author}</span> {eventText(note.body)}{" "}
        · {relativeTime(note.createdAt)}
      </p>
    );
  }
  return (
    <div>
      <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <Avatar username={note.author} size="size-4" />
        <span className="font-medium text-foreground">{note.author}</span>·{" "}
        {relativeTime(note.createdAt)}
      </p>
      <Markdown content={note.body} className="text-sm" />
    </div>
  );
}

function EventRow({ entry }: { entry: TimelineEntry }) {
  const note = entry.notes[0];
  return (
    <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Avatar username={note.author} size="size-4" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/80">{note.author}</span>{" "}
        {eventText(note.body)}
      </span>
      <span className="ml-auto shrink-0">{relativeTime(note.createdAt)}</span>
    </p>
  );
}

/** "12" or "12–15"; empty for a comment on the whole file. */
function lineLabel(position: DiffPosition): string {
  if (position.line === null) return "";
  return position.endLine !== null && position.endLine !== position.line
    ? `${position.line}–${position.endLine}`
    : `${position.line}`;
}

function positionLabel(position: DiffPosition): string {
  const lines = lineLabel(position);
  return lines.length > 0 ? `${position.path}:${lines}` : position.path;
}

function ThreadCard({
  entry,
  project,
  onReply,
  onResolve,
}: {
  entry: TimelineEntry;
  project: string;
  onReply: (discussionId: string, body: string) => Promise<void>;
  onResolve: (discussionId: string, resolved: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(!entry.resolved);
  const [resolving, setResolving] = useState(false);
  const [first, ...replies] = entry.notes;
  const comments = entry.notes.filter((note) => !note.system).length;
  const toggleResolved = () => {
    setResolving(true);
    onResolve(entry.id, !entry.resolved)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setResolving(false));
  };
  const fileName = entry.position?.path.split("/").pop() ?? "";

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-card ${
        entry.resolvable && !entry.resolved
          ? "border-foreground/25"
          : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          <span className="shrink-0">{expanded ? "▾" : "▸"}</span>
          {entry.position !== null ? (
            <span
              className="min-w-0 truncate font-mono"
              title={positionLabel(entry.position)}
            >
              {/* The file name is what a reader scans for; the full path
                  is one hover away. */}
              {fileName}
              {entry.position.line !== null
                ? `:${lineLabel(entry.position)}`
                : ""}
            </span>
          ) : (
            <span className="min-w-0 truncate">Thread</span>
          )}
          {!expanded ? (
            <span className="shrink-0">
              · {comments} comment{comments === 1 ? "" : "s"}
            </span>
          ) : null}
        </button>
        {entry.resolvable ? (
          <>
            <Badge
              variant={entry.resolved ? "secondary" : "outline"}
              className="shrink-0 font-normal"
              title={
                entry.resolvedBy !== null
                  ? `Resolved by ${entry.resolvedBy}`
                  : undefined
              }
            >
              {entry.resolved ? "resolved" : "unresolved"}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={resolving}
              onClick={toggleResolved}
            >
              {resolving ? "…" : entry.resolved ? "Reopen" : "Resolve"}
            </Button>
          </>
        ) : null}
      </div>
      {!expanded ? (
        <button
          className="block w-full truncate px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
          onClick={() => setExpanded(true)}
        >
          <span className="font-medium text-foreground/80">{first.author}</span>:{" "}
          {eventText(first.body)}
        </button>
      ) : (
        <>
          {entry.position !== null ? (
            <DiffSnippet project={project} position={entry.position} />
          ) : null}
          <div className="flex flex-col gap-3 p-3">
            <NoteBody note={first} />
            {replies.length > 0 ? (
              <div className="flex flex-col gap-3 border-l-2 border-border pl-3">
                {replies.map((note) => (
                  <NoteBody key={note.id} note={note} />
                ))}
              </div>
            ) : null}
            <ReplyBox onSubmit={(body) => onReply(entry.id, body)} />
          </div>
        </>
      )}
    </div>
  );
}

function CommentEntry({
  entry,
  onReply,
}: {
  entry: TimelineEntry;
  onReply: (discussionId: string, body: string) => Promise<void>;
}) {
  const note = entry.notes[0];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <NoteBody note={note} />
      <ReplyBox onSubmit={(body) => onReply(entry.id, body)} />
    </div>
  );
}

function ActivitySection({
  mr,
  onChanged,
}: {
  mr: MergeRequestDetail;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [filter, setFilter] = useState<ActivityFilter>(readActivityFilter);
  const chooseFilter = (next: ActivityFilter) => {
    setFilter(next);
    try {
      localStorage.setItem(ACTIVITY_FILTER_KEY, next);
    } catch {
      // private mode — the choice just won't persist
    }
  };
  const unresolved = mr.timeline.filter(
    (entry) => entry.resolvable && !entry.resolved,
  ).length;
  const visible = mr.timeline.filter((entry) =>
    filter === "all"
      ? true
      : filter === "comments"
        ? entry.kind !== "event"
        : entry.resolvable && !entry.resolved,
  );

  const onReply = useCallback(
    async (discussionId: string, body: string) => {
      await rpc.call("replyToDiscussion", {
        project: mr.project,
        iid: mr.iid,
        discussionId,
        body,
      });
      onChanged();
    },
    [rpc, mr.project, mr.iid, onChanged],
  );
  const onResolve = useCallback(
    async (discussionId: string, resolved: boolean) => {
      await rpc.call("setDiscussionResolved", {
        project: mr.project,
        iid: mr.iid,
        discussionId,
        resolved,
      });
      onChanged();
    },
    [rpc, mr.project, mr.iid, onChanged],
  );

  const chip = (value: ActivityFilter, label: string) => (
    <button
      className={`rounded-md px-2 py-0.5 text-xs ${
        filter === value
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
      onClick={() => chooseFilter(value)}
      aria-pressed={filter === value}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Activity</h3>
        <div className="ml-auto flex items-center gap-1">
          {chip("all", "All")}
          {chip("comments", "Comments")}
          {chip("unresolved", `Unresolved · ${unresolved}`)}
        </div>
      </div>
      {mr.timelineError !== null ? (
        <p className="text-xs text-destructive">
          Could not load the conversation: {mr.timelineError}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === "unresolved"
            ? "No unresolved threads."
            : "No comments yet."}
        </p>
      ) : (
        visible.map((entry) =>
          entry.kind === "event" ? (
            <EventRow key={entry.id} entry={entry} />
          ) : entry.kind === "comment" ? (
            <CommentEntry key={entry.id} entry={entry} onReply={onReply} />
          ) : (
            <ThreadCard
              key={entry.id}
              entry={entry}
              project={mr.project}
              onReply={onReply}
              onResolve={onResolve}
            />
          ),
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diffs. The host's code theme lives on <html> as data attributes plus the
// `dark` class, so the panel mirrors it into @pierre/diffs and follows a live
// theme switch instead of freezing whatever was set at mount.
// ---------------------------------------------------------------------------

interface CodeTheme {
  dark: string;
  light: string;
}

let hostCodeTheme: CodeTheme | null = null;
const hostCodeThemeListeners = new Set<() => void>();
let hostCodeThemeObserver: MutationObserver | null = null;

function getHostCodeTheme(): CodeTheme {
  hostCodeTheme ??= {
    dark: document.documentElement.dataset.bbCodeThemeDark ?? "pierre-dark",
    light: document.documentElement.dataset.bbCodeThemeLight ?? "pierre-light",
  };
  return hostCodeTheme;
}

/** One observer for the whole panel, however many diffs are mounted. */
function subscribeHostCodeTheme(onStoreChange: () => void): () => void {
  hostCodeThemeListeners.add(onStoreChange);
  hostCodeThemeObserver ??= new MutationObserver(() => {
    const current = getHostCodeTheme();
    const next: CodeTheme = {
      dark: document.documentElement.dataset.bbCodeThemeDark ?? "pierre-dark",
      light: document.documentElement.dataset.bbCodeThemeLight ?? "pierre-light",
    };
    if (next.dark === current.dark && next.light === current.light) return;
    hostCodeTheme = next;
    for (const listener of hostCodeThemeListeners) listener();
  });
  hostCodeThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bb-code-theme-dark", "data-bb-code-theme-light"],
  });
  return () => {
    hostCodeThemeListeners.delete(onStoreChange);
  };
}

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * GitLab hands out bare hunks, so a `diff --git` header is synthesized for the
 * parser. A patch it can't parse still gets shown as text rather than nothing.
 */
function DiffPatch({ path, patch }: { path: string; patch: string }) {
  const dark = useIsDarkTheme();
  const codeTheme = useSyncExternalStore(
    subscribeHostCodeTheme,
    getHostCodeTheme,
    getHostCodeTheme,
  );
  const fileDiff = useMemo(() => {
    const normalized = patch.replace(/\r\n/g, "\n").trimEnd();
    if (normalized.length === 0) return null;
    const text = normalized.startsWith("diff --git")
      ? `${normalized}\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalized}\n`;
    try {
      return parsePatchFiles(text)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [path, patch]);
  const options = useMemo(
    () =>
      ({
        diffStyle: "unified",
        overflow: "scroll",
        disableFileHeader: true,
        themeType: dark ? "dark" : "light",
        theme: codeTheme,
      }) as const,
    [codeTheme, dark],
  );
  if (fileDiff === null) {
    return (
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground/80">
        {patch}
      </pre>
    );
  }
  return <FileDiff fileDiff={fileDiff} options={options} />;
}

function FileDiffCard({ file, url }: { file: DiffFile; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="shrink-0 text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {file.path}
        </span>
        {file.status !== "modified" ? (
          <Badge
            variant="secondary"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-primary">+{file.additions}</span>
        <span className="shrink-0 text-xs text-destructive">
          −{file.deletions}
        </span>
      </button>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <DiffPatch path={file.path} patch={file.patch} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <a
              href={`${url}/diffs`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              view on GitLab ↗
            </a>
          </p>
        )
      ) : null}
    </div>
  );
}

/**
 * A long description folds, so the activity below it stays in reach; the
 * narrow side panel folds sooner and shorter than the full page.
 */
const LONG_DESCRIPTION = { compact: 1200, full: 2500 };

function DescriptionCard({
  mr,
  compact,
}: {
  mr: MergeRequestDetail;
  compact: boolean;
}) {
  const long = mr.body.length > LONG_DESCRIPTION[compact ? "compact" : "full"];
  const folded = compact
    ? "max-h-64 overflow-hidden"
    : "max-h-[36rem] overflow-hidden";
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        <Avatar username={mr.author} />
        <span className="font-medium text-foreground">{mr.author}</span>
        opened this merge request · updated {relativeTime(mr.updatedAt)}
      </div>
      <div className="p-4">
        {mr.body.length > 0 ? (
          <div className={long && !expanded ? folded : ""}>
            <Markdown content={mr.body} className="text-sm" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">(no description)</p>
        )}
        {long ? (
          <button
            className="mt-2 text-xs text-muted-foreground underline hover:text-foreground"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show less" : "Show the full description"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MergeRequestDetailView({
  project,
  iid,
  onBack,
  backLabel = "Merge requests",
  compact = false,
}: {
  project: string;
  iid: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const [mr, setMr] = useState<MergeRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getMergeRequest", { project, iid }).then(
      (result) => {
        setMr(result.mergeRequest);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid]);
  useEffect(() => {
    setMr(null);
    load();
  }, [load]);

  // Live status. GitLab moves on its own while a pipeline runs, while it
  // re-checks mergeability, and for a while after any action here (a new
  // pipeline takes seconds to attach), so the panel polls the cheap status
  // read in those windows only, and never while the page is hidden.
  const mrRef = useRef<MergeRequestDetail | null>(null);
  mrRef.current = mr;
  const pollUntil = useRef(0);
  const afterAction = useCallback(() => {
    pollUntil.current = Date.now() + 60_000;
    load();
  }, [load]);
  const moving =
    mr !== null &&
    mr.state === "opened" &&
    ((mr.pipeline !== null && PIPELINE_ACTIVE.has(mr.pipeline.status)) ||
      MERGE_CHECKING.has(mr.mergeStatus) ||
      mr.autoMerge);
  const loaded = mr !== null;
  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!moving && Date.now() > pollUntil.current) return;
      rpc.call("getMergeRequestStatus", { project, iid }).then(
        (status) => {
          const current = mrRef.current;
          if (current === null) return;
          // New commits or a merge change the timeline and diffs too.
          if (status.state !== current.state || status.sha !== current.sha) {
            load();
            return;
          }
          setMr((prev) => (prev === null ? prev : { ...prev, ...status }));
        },
        () => {
          // A missed poll is retried on the next tick.
        },
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, [rpc, project, iid, load, loaded, moving]);

  const updatePeople = useCallback(
    (people: { reviewers?: string[]; assignees?: string[] }) => {
      setMr((prev) => (prev === null ? prev : { ...prev, ...people }));
      rpc.call("setMergeRequestPeople", { project, iid, ...people }).then(
        (applied) =>
          setMr((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  reviewers: applied.reviewers,
                  assignees: applied.assignees,
                },
          ),
        (err: unknown) => {
          toast.error(errorText(err));
          load();
        },
      );
    },
    [rpc, project, iid, load],
  );

  if (error !== null) return <EmptyState message={error} />;
  if (mr === null) return <DetailSkeleton />;

  const mrLinks = links[linkKey("mr", project, iid)];
  const mainColumn = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <MergeWidget mr={mr} onChanged={afterAction} />

      {compact ? (
        <PeopleSection
          mr={mr}
          onPeople={updatePeople}
          className="grid grid-cols-2 gap-4"
        />
      ) : null}

      <DescriptionCard mr={mr} compact={compact} />

      <ActivitySection mr={mr} onChanged={load} />

      {mr.files.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {mr.filesTruncated
              ? `Changes · showing ${mr.files.length} of ${mr.changedFiles} files`
              : `Changes · ${mr.files.length} file${mr.files.length === 1 ? "" : "s"}`}
            <span className="ml-2 font-normal">
              <span className="text-primary">+{mr.additions}</span>{" "}
              <span className="text-destructive">−{mr.deletions}</span>
              {mr.filesTruncated ? " in the files below" : ""}
            </span>
          </h3>
          {mr.filesTruncated ? (
            <p className="text-xs text-muted-foreground">
              GitLab returns one page of per-file diffs, so the rest of this
              merge request — and its full line counts —{" "}
              <a
                href={`${mr.url}/diffs`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                stay on GitLab ↗
              </a>
            </p>
          ) : null}
          {mr.files.map((file) => (
            <FileDiffCard key={file.path} file={file} url={mr.url} />
          ))}
        </div>
      ) : null}

      <CommentBox
        method="commentMergeRequest"
        project={project}
        iid={iid}
        onPosted={load}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {onBack !== undefined ? (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
            ← {backLabel}
          </Button>
        ) : null}
        <span className="min-w-0 truncate">
          {project} · !{iid}
        </span>
        <span className="flex-1" />
        <a
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 underline hover:text-foreground"
        >
          Open on GitLab ↗
        </a>
      </div>

      <div className="flex items-start gap-3">
        <h2
          className={`min-w-0 flex-1 font-semibold text-foreground ${compact ? "text-base" : "text-xl"}`}
        >
          {mr.title}{" "}
          <span className="font-normal text-muted-foreground">!{mr.iid}</span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("mr", project, iid)}
        >
          {spawningKey !== null ? "Starting…" : "Review with agent"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StateBadge state={mr.state} draft={mr.draft} />
        {mr.hasConflicts ? (
          <Badge variant="destructive" className="font-normal">
            conflicts
          </Badge>
        ) : null}
        <span className="font-mono">
          {mr.sourceBranch} → {mr.targetBranch}
        </span>
        {/* With a truncated diff page the +/- sums cover only part of the
            merge request, so the overview shows GitLab's file total alone. */}
        <span>
          {mr.filesTruncated ? null : (
            <>
              <span className="text-primary">+{mr.additions}</span>{" "}
              <span className="text-destructive">−{mr.deletions}</span> ·{" "}
            </>
          )}
          {mr.changedFiles} file{mr.changedFiles === 1 ? "" : "s"}
        </span>
        <LabelChips labels={mr.labels} className="flex flex-wrap" />
        <ThreadPills links={mrLinks} />
      </div>

      {compact ? (
        mainColumn
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {mainColumn}
          <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
            <PeopleSection mr={mr} onPeople={updatePeople} />
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Labels</SidebarHeading>
              {mr.labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet</p>
              ) : (
                <LabelChips labels={mr.labels} className="flex flex-wrap" />
              )}
            </div>
            {mrLinks !== undefined && mrLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <SidebarHeading>Agents</SidebarHeading>
                <ThreadPills links={mrLinks} />
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The thread side panel (threadPanelAction): auto-resolve the thread's own
// merge request (its environment branch's, else the one it was spawned to
// review) and show the compact view; fall back to a picker over open ones.
// ---------------------------------------------------------------------------

function MergeRequestPickerList({
  onPick,
}: {
  onPick: (project: string, iid: number) => void;
}) {
  const { items, error } = useItems({ kind: "mr", state: "open" });
  if (error !== null) return <EmptyState message={error} />;
  if (items === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-5/6" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState message="No open merge requests in the tracked projects." />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <button
            key={linkKey("mr", item.project, item.iid)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
            onClick={() => onPick(item.project, item.iid)}
          >
            <StateDot state={item.state} draft={item.draft} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              !{item.iid}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
            <span
              className="hidden shrink-0 text-xs text-muted-foreground sm:block"
              title={item.project}
            >
              {shortProject(item.project)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MergeRequestPanelTab({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [resolved, setResolved] = useState(false);
  const [selected, setSelected] = useState<{
    project: string;
    iid: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("mergeRequestForThread", { threadId }).then(
      (result) => {
        if (cancelled) return;
        if (result.mergeRequest !== null) setSelected(result.mergeRequest);
        setResolved(true);
      },
      () => {
        if (!cancelled) setResolved(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!resolved) return <DetailSkeleton />;
  if (selected === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          No merge request is linked to this thread yet — pick one:
        </p>
        <MergeRequestPickerList
          onPick={(project, iid) => setSelected({ project, iid })}
        />
      </div>
    );
  }
  return (
    <MergeRequestDetailView
      project={selected.project}
      iid={selected.iid}
      compact
      backLabel="All merge requests"
      onBack={() => setSelected(null)}
    />
  );
}

// ---------------------------------------------------------------------------
// New issue form.
// ---------------------------------------------------------------------------

function NewIssueForm({
  projects,
  defaultProject,
  onCreated,
  onCancel,
}: {
  projects: ProjectInfo[];
  defaultProject: string | null;
  onCreated: (project: string, iid: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [project, setProject] = useState(
    defaultProject ?? projects[0]?.project ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);

  const create = useCallback(() => {
    setCreating(true);
    rpc
      .call("createIssue", { project, title, body })
      .then((result) => {
        toast.success("Issue created");
        onCreated(project, result.iid);
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setCreating(false));
  }, [rpc, project, title, body, onCreated]);

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">New issue</h2>
      <Select value={project} onValueChange={setProject}>
        <SelectTrigger className="w-full" aria-label="Project">
          <SelectValue placeholder="Project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((entry) => (
            <SelectItem key={entry.project} value={entry.project}>
              {entry.project}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        aria-label="Issue title"
      />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (markdown)"
        aria-label="Issue description"
        rows={8}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={creating || title.trim().length === 0 || project.length === 0}
          onClick={create}
        >
          {creating ? "Creating…" : "Create issue"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel: header, tabs, filters, routed body.
// ---------------------------------------------------------------------------

function PanelHeader() {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const status = useStatus();
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    setSyncing(true);
    setFailed(false);
    rpc
      .call("refresh")
      .catch(() => setFailed(true))
      .finally(() => setSyncing(false));
  }, [rpc]);
  return (
    <>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {failed
          ? "Sync failed — check `glab auth status`"
          : status === null
            ? "Loading…"
            : status.glabOk
              ? `${status.projects.length} project${status.projects.length === 1 ? "" : "s"} · synced ${
                  status.lastSyncedAt !== null
                    ? relativeTime(status.lastSyncedAt)
                    : "never"
                }`
              : "GitLab CLI not authenticated"}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="size-8 gap-1.5 px-0 sm:h-8 sm:w-auto sm:px-3"
        disabled={syncing}
        onClick={refresh}
        aria-label={syncing ? "Syncing GitLab data" : "Refresh GitLab data"}
      >
        <RefreshIcon className={syncing ? "animate-spin" : undefined} />
        <span className="hidden sm:inline">
          {syncing ? "Syncing…" : "Refresh"}
        </span>
      </Button>
    </>
  );
}

const QUERY_KEY = "bb-plugin-gitlab:query";
const DEFAULT_QUERY = "is:open ";

/** Radix rejects "" as an item value, so "all projects" needs a name. */
const ALL_PROJECTS = "__all__";

/**
 * Project picker beside the tabs. It reads and writes the `project:` qualifier
 * rather than holding a project of its own, so it agrees with a project typed
 * into the filter box, and it persists for free with the rest of the query.
 *
 * A project the query names but this host does not track reads as "All
 * projects": the picker can only offer what it has, and pretending otherwise
 * would silently drop the user's own filter on the next change.
 */
function ProjectPicker({
  projects,
  query,
  onQuery,
}: {
  projects: ProjectInfo[];
  query: string;
  onQuery: (query: string) => void;
}) {
  const refs = useMemo(
    () => projects.map((entry) => entry.project),
    [projects],
  );
  const selected = useMemo(
    () => queryProject(parseItemQuery(query), refs),
    [query, refs],
  );
  if (projects.length < 2) return null;
  return (
    <Select
      value={selected ?? ALL_PROJECTS}
      onValueChange={(value) =>
        onQuery(withQueryProject(query, value === ALL_PROJECTS ? null : value))
      }
    >
      <SelectTrigger
        className="h-8 w-36 text-sm sm:w-52"
        aria-label="Project"
        title={selected ?? "All projects"}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
        {projects.map((entry) => (
          <SelectItem key={entry.project} value={entry.project}>
            <span title={entry.project}>{shortProject(entry.project)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ListView({
  kind,
  projects,
  query,
  onQuery,
  onOpenItem,
}: {
  kind: Kind;
  projects: ProjectInfo[];
  query: string;
  onQuery: (query: string) => void;
  onOpenItem: (project: string, iid: number) => void;
}) {
  const { items, error } = useItems({ kind });
  const viewer = useViewer();
  const parsed = useMemo(() => parseItemQuery(query), [query]);
  const filtered = useMemo(
    () =>
      items === null
        ? null
        : items.filter((item) => matchesItemQuery(item, parsed, viewer)),
    [items, parsed, viewer],
  );

  return (
    <>
      <FilterBar
        kind={kind}
        projects={projects}
        items={items}
        value={query}
        onChange={onQuery}
      />
      <ItemsList
        kind={kind}
        items={filtered}
        error={error}
        hasFilter={query.trim().length > 0}
        onOpenItem={onOpenItem}
      />
    </>
  );
}

/**
 * Shown whenever `glab` is missing or logged out. It sits above the panel
 * instead of replacing it: the cache still has issues and merge requests worth
 * reading, only writes and detail views need a working CLI.
 */
function StatusBanner({ error }: { error: string | null }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
    >
      <p className="text-sm font-medium text-foreground">
        The GitLab CLI is not available or not authenticated
      </p>
      <p className="text-xs text-muted-foreground">
        Install glab from gitlab.com/gitlab-org/cli, run{" "}
        <span className="font-mono">glab auth login</span>, then reload the
        plugin. Cached items stay readable; edits will fail until then.
      </p>
      {error !== null && error.length > 0 ? (
        <p className="whitespace-pre-wrap font-mono text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function GitlabPanelBody({
  route,
  navigate,
  status,
  query,
  onQuery,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  query: string;
  onQuery: (query: string) => void;
}) {
  return (
    <>
      {status !== null && !status.glabOk ? (
        <StatusBanner error={status.glabError} />
      ) : null}
      <GitlabRoutedBody
        route={route}
        navigate={navigate}
        status={status}
        query={query}
        onQuery={onQuery}
      />
    </>
  );
}

function GitlabRoutedBody({
  route,
  navigate,
  status,
  query,
  onQuery,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  query: string;
  onQuery: (query: string) => void;
}) {
  const projects = status?.projects ?? [];
  if (status !== null && status.projects.length === 0) {
    return (
      <EmptyState message="No GitLab projects tracked yet. Create a BB project whose checkout has a GitLab origin remote, or add projects via the extraProjects plugin setting." />
    );
  }

  if (route.view === "issue") {
    return (
      <IssueDetailView
        project={route.project}
        iid={route.iid}
        onBack={() => navigate({ view: "issues" })}
      />
    );
  }
  if (route.view === "merge_request") {
    return (
      <MergeRequestDetailView
        project={route.project}
        iid={route.iid}
        onBack={() => navigate({ view: "merge_requests" })}
      />
    );
  }
  if (route.view === "new") {
    return (
      <NewIssueForm
        projects={projects}
        defaultProject={queryProject(
          parseItemQuery(query),
          projects.map((entry) => entry.project),
        )}
        onCreated={(project, iid) =>
          navigate(
            iid !== null
              ? { view: "issue", project, iid }
              : { view: "issues" },
          )
        }
        onCancel={() => navigate({ view: "issues" })}
      />
    );
  }

  const kind: Kind = route.view === "merge_requests" ? "mr" : "issue";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Tabs
          value={route.view}
          onValueChange={(value) =>
            navigate(
              value === "merge_requests"
                ? { view: "merge_requests" }
                : { view: "issues" },
            )
          }
        >
          <TabsList>
            <TabsTrigger value="issues">Issues</TabsTrigger>
            <TabsTrigger value="merge_requests">Merge requests</TabsTrigger>
          </TabsList>
        </Tabs>
        <ProjectPicker
          projects={projects}
          query={query}
          onQuery={onQuery}
        />
        <div className="flex-1" />
        {route.view === "issues" ? (
          <Button size="sm" onClick={() => navigate({ view: "new" })}>
            New issue
          </Button>
        ) : null}
      </div>

      <ListView
        kind={kind}
        projects={projects}
        query={query}
        onQuery={onQuery}
        onOpenItem={(project, iid) =>
          navigate(
            kind === "mr"
              ? { view: "merge_request", project, iid }
              : { view: "issue", project, iid },
          )
        }
      />
    </div>
  );
}

function GitlabPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const status = useStatus();
  const [query, setQueryState] = useState(() => {
    try {
      return window.localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY;
    } catch {
      return DEFAULT_QUERY;
    }
  });
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    try {
      window.localStorage.setItem(QUERY_KEY, next);
    } catch {
      // private mode / storage disabled — the filter just won't persist
    }
  }, []);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 md:p-5">
      <PageBody className="max-w-5xl">
        <GitlabPanelBody
          route={route}
          navigate={navigate}
          status={status}
          query={query}
          onQuery={setQuery}
        />
      </PageBody>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Homepage section: the newest open issues, scoped to the project in view
// when that project has a GitLab remote.
// ---------------------------------------------------------------------------


export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gitlab",
    title: "GitLab",
    icon: "GitMerge",
    path: PANEL_PATH,
    component: GitlabPanel,
    headerContent: PanelHeader,
  });
  app.slots.threadPanelAction({
    id: "merge-request",
    title: "Merge request",
    icon: "GitMerge",
    component: MergeRequestPanelTab,
  });
});
