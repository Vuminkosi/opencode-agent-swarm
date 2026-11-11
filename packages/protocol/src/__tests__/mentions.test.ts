/**
 * Mention lexer + resolver tests — M1-01 (spec §13 unit list).
 * Exact names, groups, @all, escaped text, code blocks, unknown and
 * killed members, ambiguous (case-fold collision) names.
 */
import { describe, expect, test } from "bun:test";
import { lexMentionTokens, parseAndResolveMentions, resolveMentions } from "../index.js";
import { ProtocolError } from "../index.js";

const snapshot = {
  members: [
    { id: "m-api", name: "api", isKilled: false },
    { id: "m-tests", name: "tests", isKilled: false },
    { id: "m-old", name: "old", isKilled: true },
  ],
  groups: { frontend: ["m-api", "m-tests"] as readonly string[] },
};

describe("lexMentionTokens", () => {
  test("exact names + @all", () => {
    const { names, mentionAll } = lexMentionTokens("hey @api and @tests, @all listen");
    expect(names).toEqual(["api", "tests"]);
    expect(mentionAll).toBe(true);
  });

  test("@@ escape is literal", () => {
    expect(lexMentionTokens("mail me at user@@example").names).toEqual([]);
    expect(lexMentionTokens("@@api is not a mention").names).toEqual([]);
  });

  test("code fences and inline code are ignored", () => {
    const body = "see ```\n@api do not wake\n``` and `@tests nope` but @api yes";
    expect(lexMentionTokens(body).names).toEqual(["api"]);
  });

  test("@ALL case-insensitive broadcast", () => {
    expect(lexMentionTokens("@ALL hands").mentionAll).toBe(true);
  });

  test("dedupes repeat mentions", () => {
    expect(lexMentionTokens("@api @api @api").names).toEqual(["api"]);
  });
});

describe("resolveMentions", () => {
  test("resolves member + group expansion", () => {
    const r = parseAndResolveMentions("@frontend go", snapshot);
    expect([...r.memberIds].sort()).toEqual(["m-api", "m-tests"]);
    expect(r.groupNames).toEqual(["frontend"]);
  });

  test("killed member resolves but is flagged", () => {
    const r = parseAndResolveMentions("@old are you there", snapshot);
    expect(r.memberIds).toContain("m-old");
    expect(r.killedIds).toContain("m-old");
  });

  test("unknown mention throws UNKNOWN_MENTION", () => {
    try {
      parseAndResolveMentions("@ghost hi", snapshot);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe("UNKNOWN_MENTION");
    }
  });

  test("case-fold collision throws AMBIGUOUS_MENTION", () => {
    const dupe = {
      members: [
        { id: "a", name: "Api", isKilled: false },
        { id: "b", name: "api", isKilled: false },
      ],
      groups: {},
    };
    try {
      resolveMentions(["API"], dupe);
      expect.unreachable();
    } catch (err) {
      expect((err as ProtocolError).code).toBe("AMBIGUOUS_MENTION");
    }
  });

  test("single case-insensitive match resolves", () => {
    const r = parseAndResolveMentions("@API please", snapshot);
    expect(r.memberIds).toEqual(["m-api"]);
  });
});
