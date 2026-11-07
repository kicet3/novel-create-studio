import { describe, expect, it } from "vitest";
import { episodeAction } from "./episode-action.js";

describe("revision chat action bar", () => {
  it("offers approve (+publish) only while awaiting approval with a request", () => {
    expect(episodeAction("awaiting_approval", true)).toMatchObject({ canApprove: true, canPublish: false });
    expect(episodeAction("awaiting_approval", false)).toMatchObject({ canApprove: false, waitingInbox: true });
  });
  it("offers publish for approved episodes and nothing for published / in-progress ones", () => {
    expect(episodeAction("approved", false)).toMatchObject({ canPublish: true, canApprove: false });
    expect(episodeAction("published", false)).toMatchObject({ canPublish: false, canApprove: false });
    expect(episodeAction("checking", false)).toMatchObject({ busy: true, canApprove: false, canPublish: false });
  });
});
