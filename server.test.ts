import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  classifyJob,
  classifyJobStatus,
  countDiffLines,
  fetchProjectItems,
  gitlabErrorMessage,
  gitlabRpcContract,
  isProjectRef,
  normalizeHostname,
  normalizeProjectRef,
  parseAuthenticatedHosts,
  parseGitlabRemote,
  parseProjectRef,
  sliceSnippet,
  toDiffPosition,
  toItems,
  toTimeline,
  validateGitlabCliArgs,
  type GitlabHost,
} from "./server";

type GitlabRpcHandlers = PluginRpcHandlers<typeof gitlabRpcContract>;

/** Hosting shapes glab supports, all keyed by the name it knows them by. */
const PLAIN: GitlabHost = {
  host: "gitlab.com",
  subfolder: "",
  sshHost: null,
  apiHost: null,
};
/** Self-managed, served under https://code.example.dev/gitlab/. */
const SUBFOLDER: GitlabHost = {
  host: "code.example.dev",
  subfolder: "gitlab",
  sshHost: null,
  apiHost: null,
};
/** Self-managed behind a port, with git-over-SSH on its own name. */
const SPLIT: GitlabHost = {
  host: "devops.corp",
  subfolder: "",
  sshHost: "ssh.devops.corp",
  apiHost: "devops.corp:8443",
};
const HOSTS: GitlabHost[] = [PLAIN, SUBFOLDER, SPLIT];

function assertGitlabFrontendInference(
  client: PluginRpcClient<typeof gitlabRpcContract>,
) {
  expectTypeOf(
    client.call("getMergeRequest", {
      project: "gitlab.com/group/sub/app",
      iid: 42,
    }),
  ).resolves.toHaveProperty("mergeRequest");

  // @ts-expect-error merge-request iids are numeric.
  void client.call("getIssue", { project: "gitlab.com/group/app", iid: "42" });
  // @ts-expect-error the contract only knows issues and merge requests.
  void client.call("listItems", { kind: "epic" });
}

describe("GitLab project refs", () => {
  it("reads a host-qualified ref out of every remote shape", () => {
    expect(parseGitlabRemote("git@gitlab.com:group/sub/app.git", HOSTS)).toBe(
      "gitlab.com/group/sub/app",
    );
    expect(parseGitlabRemote("https://gitlab.com/group/app.git\n", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("ssh://git@gitlab.com:2222/group/sub/deep/app", HOSTS),
    ).toBe("gitlab.com/group/sub/deep/app");
    // Case and IDN are normalized so one instance is never tracked twice and
    // the ref stays the ASCII name DNS and glab both use.
    expect(parseGitlabRemote("git@GitLab.com:group/app.git", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("https://xn--gitlb-jra.example/g/a.git", [
        { host: "gitläb.example", subfolder: "", sshHost: null, apiHost: null },
      ]),
    ).toBe("xn--gitlb-jra.example/g/a");
  });

  it("resolves the hosting variants glab describes in its host config", () => {
    // A subfolder is part of the URL but never part of the project path.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/group/app.git", HOSTS),
    ).toBe("code.example.dev/group/app");
    // Ports never reach a ref: `glab --hostname` rejects them, and the port
    // belongs to the host's api_host config instead.
    expect(
      parseGitlabRemote("https://devops.corp:8443/team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // Git over SSH answering on another name still maps to the glab host.
    expect(
      parseGitlabRemote("git@ssh.devops.corp:team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // A subfolder-shaped path on a host without one stays untouched.
    expect(parseGitlabRemote("https://gitlab.com/gitlab/app.git", HOSTS)).toBe(
      "gitlab.com/gitlab/app",
    );
  });

  it("keeps untracked hosts and namespace-less paths out of discovery", () => {
    expect(parseGitlabRemote("git@github.com:acme/widgets.git", HOSTS)).toBeNull();
    // A user-level path with no namespace is not a project.
    expect(parseGitlabRemote("https://gitlab.com/app.git", HOSTS)).toBeNull();
    // A subfolder install whose remote carries only the subfolder + project.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/app.git", HOSTS),
    ).toBeNull();
    expect(parseGitlabRemote("", HOSTS)).toBeNull();
    expect(parseGitlabRemote("git@gitlab.com:group/app.git", [])).toBeNull();
    // IPv6 literals: glab refuses them, so the plugin must not invent a ref.
    expect(normalizeHostname("[2001:db8::1]")).toBeNull();
    expect(normalizeHostname("[2001:db8::1]:8443")).toBeNull();
  });

  it("normalizes whatever a user types into extraProjects", () => {
    // Host-qualified, with scheme, case, port, subfolder and trailing slash.
    expect(
      normalizeProjectRef(
        "HTTPS://Code.Example.DEV/gitlab/group/app/",
        HOSTS,
        "gitlab.com",
      ),
    ).toBe("code.example.dev/group/app");
    expect(
      normalizeProjectRef("devops.corp:8443/team/web/app", HOSTS, "gitlab.com"),
    ).toBe("devops.corp/team/web/app");
    // A bare path takes the configured default host, whatever domain that is.
    expect(normalizeProjectRef("group/app", HOSTS, "gitlab.internal")).toBe(
      "gitlab.internal/group/app",
    );
    // An instance glab does not know yet stays addressable for after login.
    expect(
      normalizeProjectRef("git.new-team.dev/group/app", HOSTS, "gitlab.com"),
    ).toBe("git.new-team.dev/group/app");
    expect(normalizeProjectRef("not a project", HOSTS, "gitlab.com")).toBeNull();
    expect(normalizeProjectRef("   ", HOSTS, "gitlab.com")).toBeNull();
  });

  it("splits a ref at the host, never at every slash", () => {
    expect(parseProjectRef("gitlab.example.dev/group/sub/app")).toEqual({
      host: "gitlab.example.dev",
      path: "group/sub/app",
    });
    expect(() => parseProjectRef("gitlab.com")).toThrow("malformed");
    expect(isProjectRef("gitlab.com/group")).toBe(true);
    expect(isProjectRef("gitlab.com/")).toBe(false);
    expect(isProjectRef("group/app")).toBe(true);
  });
});

describe("glab plumbing", () => {
  it("collects only the hosts glab reports as logged in", () => {
    const status = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401",
      "  ! No token found (checked config file, keyring, and environment variables).",
      "gitlab.example.dev",
      "  ✓ Logged in to gitlab.example.dev as tanuki (/home/me/config.yml)",
      "  ✓ Token found: **************************",
    ].join("\n");
    expect(parseAuthenticatedHosts(status)).toEqual(["gitlab.example.dev"]);
    expect(parseAuthenticatedHosts("")).toEqual([]);
  });

  it("counts diff lines without charging the +++/--- headers", () => {
    const diff = [
      "@@ -1,4 +1,5 @@",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      " context",
      "-removed",
      "+added one",
      "+added two",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("maps GitLab job statuses onto the panel's traffic light", () => {
    expect(classifyJobStatus("success")).toBe("success");
    expect(classifyJobStatus("failed")).toBe("failure");
    expect(classifyJobStatus("running")).toBe("pending");
    expect(classifyJobStatus("waiting_for_resource")).toBe("pending");
    // A manual or skipped job is not a failure — it is simply not a signal.
    expect(classifyJobStatus("manual")).toBe("neutral");
    expect(classifyJobStatus("skipped")).toBe("neutral");
  });

  it("shows a failure the pipeline may ignore as a warning, not red", () => {
    // GitLab calls such a pipeline "success"; red jobs would contradict it.
    expect(classifyJob("failed", true)).toBe("warning");
    expect(classifyJob("failed", false)).toBe("failure");
    expect(classifyJob("success", true)).toBe("success");
    expect(classifyJob("running", true)).toBe("pending");
  });

  it("reads GitLab's reason out of an error body", () => {
    expect(gitlabErrorMessage('{"message":"404 Not found"}')).toBe(
      "404 Not found",
    );
    expect(gitlabErrorMessage('{"error":"text is missing"}')).toBe(
      "text is missing",
    );
    expect(
      gitlabErrorMessage(
        '{"message":{"base":["Branch cannot be merged"],"sha":["is stale"]}}',
      ),
    ).toBe("base Branch cannot be merged; sha is stale");
    expect(gitlabErrorMessage('{"message":["one","two"]}')).toBe("one; two");
    expect(gitlabErrorMessage("")).toBeNull();
    expect(gitlabErrorMessage("<html>502</html>")).toBeNull();
    expect(gitlabErrorMessage('{"id":1}')).toBeNull();
  });

  it("rejects CLI arguments that would otherwise broaden a project query", () => {
    expect(validateGitlabCliArgs(["issues", "gitlab.com/group/sub/app"])).toBeNull();
    expect(validateGitlabCliArgs(["issues", "not a project"])).toContain(
      "expected host/group/project",
    );
    expect(
      validateGitlabCliArgs(["mrs", "gitlab.com/group/app", "extra"]),
    ).toContain("Unexpected argument");
    expect(validateGitlabCliArgs(["projects", "--json"])).toContain(
      "does not accept arguments",
    );
  });
});

describe("GitLab payload parsing", () => {
  it("normalizes issue and merge-request rows, dropping unusable ones", () => {
    const rows = [
      {
        iid: 7,
        title: "Fix the flaky spec",
        state: "opened",
        work_in_progress: true,
        author: { id: 3, username: "tanuki" },
        labels: ["bug", "ci"],
        assignees: [{ id: 4, username: "mensahs" }, { id: 5, username: "" }],
        reviewers: [{ id: 6, username: "kaito" }, { id: 7, username: "" }],
        web_url: "https://gitlab.com/group/app/-/merge_requests/7",
        description: "It fails once per week.",
        updated_at: "2026-08-14T12:29:03.902Z",
      },
      // No iid: GitLab cannot address it, so neither can the cache.
      { title: "orphan" },
    ];
    expect(toItems(rows, "gitlab.com/group/app", "mr")).toEqual([
      {
        project: "gitlab.com/group/app",
        iid: 7,
        kind: "mr",
        title: "Fix the flaky spec",
        state: "opened",
        draft: true,
        author: "tanuki",
        labels: ["bug", "ci"],
        assignees: ["mensahs"],
        reviewers: ["kaito"],
        url: "https://gitlab.com/group/app/-/merge_requests/7",
        body: "It fails once per week.",
        updatedAt: "2026-08-14T12:29:03.902Z",
      },
    ]);
  });

  it("falls back to empty fields rather than failing a whole list", () => {
    const items = toItems([{ iid: 1, description: null, labels: null }], "gitlab.com/g/a", "issue");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "", state: "opened", body: "", labels: [], author: "" });
    expect(toItems({ message: "404 Not found" }, "gitlab.com/g/a", "issue")).toEqual([]);
  });

  it("keeps merge requests when a project has issues disabled", async () => {
    const endpoints: string[] = [];
    const items = await fetchProjectItems(async (_project, endpoint) => {
      endpoints.push(endpoint);
      if (endpoint.includes("/issues?")) {
        throw new Error("glab api failed: 404 Not found (HTTP 404)");
      }
      if (endpoint.includes("state=opened")) {
        return [
          {
            iid: 12,
            title: "Add geometries",
            state: "opened",
            author: { username: "mensahs" },
            web_url: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
            updated_at: "2026-08-14T12:29:03.902Z",
          },
        ];
      }
      return [];
    }, "gitlab.example.dev/group/sub/app");

    // Subgroup paths must reach GitLab URL-encoded, as one id segment.
    expect(
      endpoints.every((endpoint) =>
        endpoint.startsWith("projects/group%2Fsub%2Fapp/"),
      ),
    ).toBe(true);
    expect(endpoints).toHaveLength(5);
    expect(items).toEqual([
      {
        project: "gitlab.example.dev/group/sub/app",
        iid: 12,
        kind: "mr",
        title: "Add geometries",
        state: "opened",
        draft: false,
        author: "mensahs",
        labels: [],
        assignees: [],
        reviewers: [],
        url: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
        body: "",
        updatedAt: "2026-08-14T12:29:03.902Z",
      },
    ]);
  });

  it("lets a genuine failure abort the sync instead of caching an empty project", async () => {
    await expect(
      fetchProjectItems(async () => {
        throw new Error("glab api failed: 500 Internal Server Error");
      }, "gitlab.com/group/app"),
    ).rejects.toThrow("500");
  });
});

describe("merge-request timeline", () => {
  const user = (username: string) => ({ id: 1, username });
  const note = (fields: Record<string, unknown>) => ({
    id: 1,
    body: "text",
    system: false,
    resolvable: false,
    resolved: false,
    created_at: "2026-09-20T10:00:00.000Z",
    author: user("dana"),
    ...fields,
  });
  const diffPosition = {
    new_path: "src/app.ts",
    old_path: "src/app.ts",
    new_line: 12,
    old_line: null,
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    line_range: null,
  };

  it("keeps replies under the comment they answer", () => {
    const timeline = toTimeline([
      {
        id: "d1",
        individual_note: true,
        notes: [
          note({ id: 10, system: true, body: "requested review from @kai" }),
        ],
      },
      {
        id: "d2",
        individual_note: true,
        notes: [note({ id: 11, body: "Looks fine overall." })],
      },
      {
        id: "d3",
        individual_note: false,
        notes: [
          note({
            id: 12,
            body: "Why is this mocked?",
            resolvable: true,
            resolved: true,
            resolved_by: user("sam"),
            position: diffPosition,
          }),
          note({
            id: 13,
            system: true,
            body: "changed this line in [version 2 of the diff](/x)",
            position: diffPosition,
          }),
          note({
            id: 14,
            author: user("sam"),
            body: "Removed it.",
            resolvable: true,
            resolved: true,
            position: diffPosition,
          }),
        ],
      },
    ]);

    expect(timeline.map((entry) => entry.kind)).toEqual([
      "event",
      "comment",
      "thread",
    ]);
    const thread = timeline[2];
    expect(thread.id).toBe("d3");
    expect(thread.notes.map((entry) => entry.id)).toEqual([12, 13, 14]);
    expect(thread.notes[1].system).toBe(true);
    expect(thread).toMatchObject({
      resolvable: true,
      resolved: true,
      resolvedBy: "sam",
      position: {
        path: "src/app.ts",
        side: "new",
        line: 12,
        endLine: 12,
        ref: "a".repeat(40),
      },
    });
  });

  it("marks a thread unresolved while any resolvable note is open", () => {
    const [thread] = toTimeline([
      {
        id: "d1",
        individual_note: false,
        notes: [
          note({ id: 1, resolvable: true, resolved: true }),
          note({ id: 2, resolvable: true, resolved: false }),
        ],
      },
    ]);
    expect(thread).toMatchObject({
      kind: "thread",
      resolvable: true,
      resolved: false,
      resolvedBy: null,
      position: null,
    });
  });

  it("drops blank notes, empty discussions, and rows with no id", () => {
    const timeline = toTimeline([
      { id: "", individual_note: true, notes: [note({ id: 1 })] },
      { id: "d2", individual_note: true, notes: [note({ id: 2, body: "  " })] },
      {
        id: "d3",
        individual_note: false,
        notes: [note({ id: 3, body: "" }), note({ id: 4, body: "kept" })],
      },
    ]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].notes.map((entry) => entry.id)).toEqual([4]);
    expect(toTimeline("not a list")).toEqual([]);
  });

  it("keeps GitLab's order, sorting only by the first note's time", () => {
    const timeline = toTimeline([
      {
        id: "late",
        individual_note: true,
        notes: [note({ created_at: "2026-09-21T00:00:00.000Z" })],
      },
      {
        id: "early",
        individual_note: true,
        notes: [note({ created_at: "2026-09-20T00:00:00.000Z" })],
      },
      {
        id: "early-2",
        individual_note: true,
        notes: [note({ created_at: "2026-09-20T00:00:00.000Z" })],
      },
    ]);
    expect(timeline.map((entry) => entry.id)).toEqual([
      "early",
      "early-2",
      "late",
    ]);
  });

  it("reads a removed line from the base commit", () => {
    expect(
      toDiffPosition({
        ...diffPosition,
        new_path: "src/renamed.ts",
        old_path: "src/app.ts",
        new_line: null,
        old_line: 30,
      }),
    ).toEqual({
      path: "src/app.ts",
      side: "old",
      line: 30,
      endLine: 30,
      ref: "b".repeat(40),
    });
  });

  it("keeps the range of a multi-line comment", () => {
    expect(
      toDiffPosition({
        ...diffPosition,
        new_line: 15,
        line_range: {
          start: { new_line: 11, old_line: null },
          end: { new_line: 15, old_line: null },
        },
      }),
    ).toMatchObject({ line: 11, endLine: 15 });
  });

  it("has no lines for a comment on a whole file", () => {
    expect(
      toDiffPosition({ ...diffPosition, new_line: null, old_line: null }),
    ).toEqual({
      path: "src/app.ts",
      side: "new",
      line: null,
      endLine: null,
      ref: "a".repeat(40),
    });
    expect(toDiffPosition(null)).toBeNull();
  });

  it("cuts the thread's lines out of a file, with a little context", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    expect(sliceSnippet(text, 10, 10)).toEqual({
      startLine: 7,
      lines: ["line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
    });
    // Near the top and bottom the context shrinks instead of going out of range.
    expect(sliceSnippet(text, 1, 1).startLine).toBe(1);
    expect(sliceSnippet(text, 20, 20).lines.at(-1)).toBe("line 20");
    // A line past the end (the file changed since) is clamped, not refused.
    expect(sliceSnippet(text, 99, 99).lines.at(-1)).toBe("line 20");
    // A trailing newline is not an extra empty line.
    expect(sliceSnippet("a\nb\n", 2, 2).lines).toEqual(["a", "b"]);
  });

  it("caps a very long range", () => {
    const text = Array.from({ length: 500 }, (_, i) => `${i + 1}`).join("\n");
    expect(sliceSnippet(text, 10, 400).lines).toHaveLength(40);
  });
});

describe("rpc contract", () => {
  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GitlabRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      project: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGitlabFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitlab-contract",
    });
    const contract = defineRpcContract({
      startReview: gitlabRpcContract.startReview,
    });
    bb.rpc.register(contract, {
      startReview() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startReview", { project: "group", iid: 4 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("refuses ids that could change the GitLab URL they are put in", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitlab-contract-ids",
    });
    const contract = defineRpcContract({
      replyToDiscussion: gitlabRpcContract.replyToDiscussion,
      setApproval: gitlabRpcContract.setApproval,
      getDiffSnippet: gitlabRpcContract.getDiffSnippet,
      jobAction: gitlabRpcContract.jobAction,
    });
    bb.rpc.register(contract, {
      replyToDiscussion: () => ({ ok: true as const }),
      setApproval: () => ({ ok: true as const }),
      getDiffSnippet: () => ({ startLine: 1, lines: [] }),
      jobAction: () => ({ ok: true as const }),
    });
    const project = "gitlab.com/group/app";

    await expect(
      harness.callRpc("replyToDiscussion", {
        project,
        iid: 4,
        discussionId: "../../../projects",
        body: "hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("replyToDiscussion", {
        project,
        iid: 4,
        discussionId: "a1b2c3d4e5",
        body: "   ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("setApproval", {
        project,
        iid: 4,
        approved: true,
        sha: "main",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("getDiffSnippet", {
        project,
        ref: "a".repeat(40),
        path: "/etc/passwd",
        line: 1,
        endLine: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("jobAction", { project, jobId: 7, action: "erase" }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      harness.callRpc("replyToDiscussion", {
        project,
        iid: 4,
        discussionId: "a1b2c3d4e5",
        body: "Thanks!",
      }),
    ).resolves.toEqual({ ok: true });
  });
});
