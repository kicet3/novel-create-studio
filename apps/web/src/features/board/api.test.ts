import { describe, expect, it } from "vitest";
import type { TaskDto } from "@ncs/shared";
import { allowedActions } from "./api.js";

const task = (over: Partial<TaskDto>): TaskDto => ({ status: "ready", pausedAt: null, ...over }) as TaskDto;

describe("allowedActions", () => {
  it("offers retry/cancel for failed tasks", () => {
    expect(allowedActions(task({ status: "failed" }))).toEqual(["retry", "cancel"]);
  });
  it("offers pause or resume for live tasks", () => {
    expect(allowedActions(task({ status: "running" }))).toEqual(["pause", "cancel"]);
    expect(allowedActions(task({ status: "blocked", pausedAt: "2026-11-05T00:00:00Z" }))).toEqual(["resume", "cancel"]);
  });
  it("offers nothing for terminal tasks", () => {
    expect(allowedActions(task({ status: "done" }))).toEqual([]);
    expect(allowedActions(task({ status: "cancelled" }))).toEqual([]);
  });
});
