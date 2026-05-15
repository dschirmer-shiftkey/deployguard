import { vi } from "vitest";

export const info = vi.fn();
export const warning = vi.fn();
export const debug = vi.fn();
export const error = vi.fn();
export const setFailed = vi.fn();
export const setOutput = vi.fn();
export const getInput = vi.fn().mockReturnValue("");

export const summary = {
  addRaw: vi.fn().mockReturnThis(),
  addHeading: vi.fn().mockReturnThis(),
  addCodeBlock: vi.fn().mockReturnThis(),
  write: vi.fn().mockResolvedValue(undefined),
};
