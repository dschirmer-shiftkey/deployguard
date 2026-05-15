import { vi } from "vitest";

export const context = {
  repo: { owner: "test-owner", repo: "test-repo" },
  payload: {},
  sha: "abc1234567890",
  eventName: "pull_request",
};

export const getOctokit = vi.fn(() => ({ rest: {} }));
