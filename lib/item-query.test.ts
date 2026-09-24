import { describe, expect, it } from "vitest";
import {
  matchesItemQuery,
  parseItemQuery,
  queryProject,
  suggestQueryTokens,
  withQueryProject,
  type QueryableItem,
} from "./item-query";

const ISSUE: QueryableItem = {
  kind: "issue",
  project: "gitlab.com/acme/web",
  iid: 42,
  title: "Login times out",
  state: "opened",
  draft: false,
  author: "dana",
  labels: ["bug", "needs triage"],
  assignees: ["Rio"],
  reviewers: [],
};

const MR: QueryableItem = {
  kind: "mr",
  project: "code.example.dev/acme/api",
  iid: 7,
  title: "Rework token refresh",
  state: "merged",
  draft: true,
  author: "rio",
  labels: [],
  assignees: [],
  reviewers: ["Dana"],
};

const match = (query: string, item: QueryableItem, viewer: string | null = null) =>
  matchesItemQuery(item, parseItemQuery(query), viewer);

describe("parseItemQuery", () => {
  it("maps the state people type onto the state GitLab stores", () => {
    expect(parseItemQuery("is:open").states).toEqual(["opened"]);
    expect(parseItemQuery("state:merged is:closed").states).toEqual([
      "merged",
      "closed",
    ]);
  });

  it("keeps draft out of the state list — GitLab holds it separately", () => {
    const parsed = parseItemQuery("is:open is:draft");
    expect(parsed.states).toEqual(["opened"]);
    expect(parsed.draftOnly).toBe(true);
  });

  it("takes quoted values as one label and drops the quotes", () => {
    expect(parseItemQuery('label:"needs triage" bug').labels).toEqual([
      "needs triage",
    ]);
  });

  it("ignores a half-typed qualifier instead of filtering on empty", () => {
    const parsed = parseItemQuery("label: assignee:");
    expect(parsed.labels).toEqual([]);
    expect(parsed.assignees).toEqual([]);
    expect(parsed.text).toEqual([]);
  });

  it("treats unqualified words as text terms", () => {
    expect(parseItemQuery("login TIMEOUT").text).toEqual(["login", "timeout"]);
  });

  it("collects reviewer: separately from assignee:", () => {
    const parsed = parseItemQuery("reviewer:Dana assignee:rio");
    expect(parsed.reviewers).toEqual(["dana"]);
    expect(parsed.assignees).toEqual(["rio"]);
  });
});

describe("matchesItemQuery", () => {
  it("requires every text term but only one of a repeated qualifier", () => {
    expect(match("login times", ISSUE)).toBe(true);
    expect(match("login missing", ISSUE)).toBe(false);
    expect(match("label:bug label:regression", ISSUE)).toBe(true);
  });

  it("matches an iid with its GitLab marker", () => {
    expect(match("#42", ISSUE)).toBe(true);
    expect(match("!42", ISSUE)).toBe(false);
    expect(match("!7", MR)).toBe(true);
  });

  it("resolves @me against the viewer, case-insensitively", () => {
    expect(match("assignee:@me", ISSUE, "rio")).toBe(true);
    expect(match("assignee:@me", ISSUE, "dana")).toBe(false);
    expect(match("author:@me", ISSUE, "dana")).toBe(true);
  });

  it("matches nothing for @me while the viewer is unknown", () => {
    expect(match("assignee:@me", ISSUE, null)).toBe(false);
  });

  it("narrows drafts without dropping the state filter", () => {
    expect(match("is:draft", MR)).toBe(true);
    expect(match("is:draft", ISSUE)).toBe(false);
    expect(match("is:open is:draft", MR)).toBe(false);
  });

  it("filters on the host-qualified project ref", () => {
    expect(match("project:gitlab.com/acme/web", ISSUE)).toBe(true);
    expect(match("project:acme/web", ISSUE)).toBe(false);
  });

  it("finds items missing an assignee or a label", () => {
    expect(match("no:assignee", MR)).toBe(true);
    expect(match("no:assignee", ISSUE)).toBe(false);
    expect(match("no:label", MR)).toBe(true);
    expect(match("no:label", ISSUE)).toBe(false);
  });

  it("filters on the reviewer, case-insensitively and against @me", () => {
    expect(match("reviewer:dana", MR)).toBe(true);
    expect(match("reviewer:rio", MR)).toBe(false);
    expect(match("reviewer:@me", MR, "dana")).toBe(true);
    expect(match("reviewer:@me", MR, "rio")).toBe(false);
  });

  it("keeps reviewer: and assignee: apart", () => {
    // MR is reviewed by Dana and assigned to nobody.
    expect(match("assignee:dana", MR)).toBe(false);
    expect(match("reviewer:dana no:assignee", MR)).toBe(true);
  });

  it("matches no issue on reviewer: — GitLab has no such field there", () => {
    expect(match("reviewer:rio", ISSUE)).toBe(false);
    expect(match("reviewer:@me", ISSUE, "dana")).toBe(false);
    expect(match("no:reviewer", ISSUE)).toBe(true);
    expect(match("no:reviewer", MR)).toBe(false);
  });
});

describe("suggestQueryTokens", () => {
  const vocab = {
    users: ["dana", "rio"],
    labels: ["bug", "needs triage"],
    projects: ["gitlab.com/acme/web"],
  };

  it("completes qualifier keys by prefix", () => {
    expect(
      suggestQueryTokens("la", vocab, "issue", null).map((s) => s.insert),
    ).toEqual(["label:"]);
  });

  it("offers merged and draft only for merge requests", () => {
    expect(
      suggestQueryTokens("is:", vocab, "mr", null).map((s) => s.label),
    ).toEqual(["open", "draft", "closed", "merged"]);
    expect(
      suggestQueryTokens("is:", vocab, "issue", null).map((s) => s.label),
    ).toEqual(["open", "closed"]);
  });

  it("labels @me with the viewer and carries an avatar username", () => {
    const [me] = suggestQueryTokens("assignee:", vocab, "issue", "dana");
    expect(me).toMatchObject({
      insert: "assignee:@me ",
      label: "@me (dana)",
      username: "dana",
    });
  });

  it("quotes a completed value that contains whitespace", () => {
    expect(
      suggestQueryTokens("label:needs", vocab, "issue", null).map(
        (s) => s.insert,
      ),
    ).toEqual(['label:"needs triage" ']);
  });

  it("completes a value that is already partly typed", () => {
    expect(
      suggestQueryTokens("author:ri", vocab, "issue", null).map((s) => s.label),
    ).toEqual(["rio"]);
  });

  it("offers reviewer: on merge requests only", () => {
    expect(
      suggestQueryTokens("re", vocab, "mr", null).map((s) => s.insert),
    ).toEqual(["reviewer:"]);
    expect(suggestQueryTokens("re", vocab, "issue", null)).toEqual([]);
  });

  it("completes a reviewer the same way as an assignee", () => {
    const [me] = suggestQueryTokens("reviewer:", vocab, "mr", "dana");
    expect(me).toMatchObject({
      insert: "reviewer:@me ",
      label: "@me (dana)",
      username: "dana",
    });
  });

  it("offers no:reviewer on merge requests only", () => {
    expect(suggestQueryTokens("no:", vocab, "mr", null).map((s) => s.label)).toEqual(
      ["no:assignee", "no:reviewer", "no:label"],
    );
    expect(
      suggestQueryTokens("no:", vocab, "issue", null).map((s) => s.label),
    ).toEqual(["no:assignee", "no:label"]);
  });
});

describe("withQueryProject", () => {
  it("replaces the project where it stands, keeping the other qualifiers", () => {
    expect(
      withQueryProject("is:open project:gitlab.com/acme/web author:@me", "x.dev/a/b"),
    ).toBe("is:open project:x.dev/a/b author:@me ");
  });

  it("appends the project when the query has none", () => {
    expect(withQueryProject("is:open ", "x.dev/a/b")).toBe(
      "is:open project:x.dev/a/b ",
    );
    expect(withQueryProject("", "x.dev/a/b")).toBe("project:x.dev/a/b ");
  });

  it("drops every project token when widened to all projects", () => {
    expect(
      withQueryProject("project:a.dev/a/b is:open project:c.dev/c/d", null),
    ).toBe("is:open ");
    expect(withQueryProject("project:a.dev/a/b", null)).toBe("");
  });

  it("keeps one project when the query named several", () => {
    expect(
      withQueryProject("project:a.dev/a/b project:c.dev/c/d", "x.dev/a/b"),
    ).toBe("project:x.dev/a/b ");
  });

  it("round-trips through the parser", () => {
    const next = withQueryProject("is:open", "gitlab.com/acme/web");
    expect(queryProject(parseItemQuery(next), ["gitlab.com/acme/web"])).toBe(
      "gitlab.com/acme/web",
    );
  });
});

describe("queryProject", () => {
  it("picks the first project: value that names a tracked project", () => {
    expect(
      queryProject(parseItemQuery("project:gone project:gitlab.com/acme/web"), [
        "gitlab.com/acme/web",
      ]),
    ).toBe("gitlab.com/acme/web");
    expect(queryProject(parseItemQuery("is:open"), ["gitlab.com/acme/web"])).toBe(
      null,
    );
  });
});
