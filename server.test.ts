import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  classifyJobStatus,
  countDiffLines,
  fetchProjectItems,
  gitlabRpcContract,
  isProjectRef,
  normalizeHostname,
  normalizeProjectRef,
  parseAuthenticatedHosts,
  parseGitlabRemote,
  parseProjectRef,
  toItems,
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
});
