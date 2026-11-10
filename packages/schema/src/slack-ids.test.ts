import { describe, expect, it } from "vitest";
import { collectSlackIds, rewriteSlackIds, slackProfileName } from "./slack-ids.ts";

const names = new Map([
  ["U0AGSDC5GR3", "Ada Lovelace"],
  ["U0AH9E4P085", "Atif (BNL)"],
]);

describe("slack id rewrite", () => {
  it("prefers real name over display name and handle", () => {
    expect(
      slackProfileName({
        name: "ada",
        real_name: "Ada Lovelace",
        profile: { display_name: "ada", real_name: "Ada Lovelace" },
      }),
    ).toBe("Ada Lovelace");
    expect(slackProfileName({ name: "ada", profile: { display_name: "Countess" } })).toBe(
      "Countess",
    );
    expect(slackProfileName({})).toBeNull();
  });

  it("collects mention and bare ids", () => {
    expect(
      collectSlackIds("U0AGSDC5GR3 asked <@U0AH9E4P085|atif> about https://x/U0AGSDC5GR3").sort(),
    ).toEqual(["U0AGSDC5GR3", "U0AH9E4P085"]);
  });

  it("replaces a bare id used as a person's name", () => {
    expect(
      rewriteSlackIds(
        "U0AGSDC5GR3 received 404 errors on all GitLab links and could not sign in",
        names,
      ),
    ).toBe("Ada Lovelace received 404 errors on all GitLab links and could not sign in");
  });

  it("rewrites mentions, keeps unknown mentions, and uses a label when present", () => {
    expect(rewriteSlackIds("ask <@U0AH9E4P085> or <@UZZZ>", names, { atMentions: true })).toBe(
      "ask @Atif (BNL) or <@UZZZ>",
    );
    expect(rewriteSlackIds("ping <@UNEWUSER1|Pat Lee>", names)).toBe("ping Pat Lee");
  });

  it("does not rewrite ids inside URLs", () => {
    const url = "https://example.slack.com/team/U0AGSDC5GR3";
    expect(rewriteSlackIds(url, names)).toBe(url);
  });
});
