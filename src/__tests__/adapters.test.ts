import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerAdapter,
  clearAdapters,
  getAdapter,
  getAvailableAdapters,
  listAdapterNames,
  runAllAvailable,
  registerAllAdapters,
  vercelAdapter,
  supabaseAdapter,
  awsEcsAdapter,
  flyIoAdapter,
  cloudflareAdapter,
  type HealthCheckAdapter,
} from "../adapters/index.js";

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("adapter registry", () => {
  beforeEach(() => {
    clearAdapters();
  });

  it("registers and retrieves adapters by name", () => {
    const mock: HealthCheckAdapter = {
      name: "test-adapter",
      detect: () => true,
      check: async () => ({
        target: "test",
        status: "healthy",
        latencyMs: 1,
        detail: {},
      }),
    };
    registerAdapter(mock);
    expect(getAdapter("test-adapter")).toBe(mock);
    expect(getAdapter("nonexistent")).toBeUndefined();
  });

  it("lists registered adapter names", () => {
    registerAdapter(vercelAdapter);
    registerAdapter(supabaseAdapter);
    expect(listAdapterNames()).toEqual(["vercel", "supabase"]);
  });

  it("filters to available adapters based on detect()", () => {
    const available: HealthCheckAdapter = {
      name: "available",
      detect: () => true,
      check: async () => ({
        target: "a",
        status: "healthy",
        latencyMs: 1,
        detail: {},
      }),
    };
    const unavailable: HealthCheckAdapter = {
      name: "unavailable",
      detect: () => false,
      check: async () => ({
        target: "b",
        status: "down",
        latencyMs: 1,
        detail: {},
      }),
    };
    registerAdapter(available);
    registerAdapter(unavailable);
    expect(getAvailableAdapters()).toEqual([available]);
  });

  it("runAllAvailable runs only detected adapters", async () => {
    const checkFn = vi.fn().mockResolvedValue({
      target: "test",
      status: "healthy",
      latencyMs: 1,
      detail: {},
    });
    registerAdapter({ name: "a", detect: () => true, check: checkFn });
    registerAdapter({
      name: "b",
      detect: () => false,
      check: vi.fn(),
    });

    const results = await runAllAvailable();
    expect(results).toHaveLength(1);
    expect(checkFn).toHaveBeenCalledOnce();
  });

  it("clearAdapters removes all registered adapters", () => {
    registerAdapter(vercelAdapter);
    expect(listAdapterNames()).toHaveLength(1);
    clearAdapters();
    expect(listAdapterNames()).toHaveLength(0);
  });

  it("registerAllAdapters registers all 5 built-in adapters", () => {
    registerAllAdapters();
    expect(listAdapterNames()).toEqual([
      "vercel",
      "supabase",
      "aws-ecs",
      "fly-io",
      "cloudflare",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Vercel adapter
// ---------------------------------------------------------------------------

describe("vercel adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TEAM_ID;
  });

  it("detect() returns false without env vars", () => {
    expect(vercelAdapter.detect()).toBe(false);
  });

  it("detect() returns true with env vars", () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_PROJECT_ID = "prj";
    expect(vercelAdapter.detect()).toBe(true);
  });

  it("returns healthy for READY deployment", async () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_PROJECT_ID = "prj";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployments: [
            { readyState: "READY", url: "app.vercel.app", createdAt: 1700000000000 },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await vercelAdapter.check();
    expect(result.status).toBe("healthy");
    expect(result.detail.provider).toBe("vercel");
  });

  it("returns degraded for non-200 response", async () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_PROJECT_ID = "prj";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("err", { status: 403 }));
    const result = await vercelAdapter.check();
    expect(result.status).toBe("degraded");
  });

  it("returns down on network error", async () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_PROJECT_ID = "prj";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await vercelAdapter.check();
    expect(result.status).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// Supabase adapter
// ---------------------------------------------------------------------------

describe("supabase adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("detect() returns false without env vars", () => {
    expect(supabaseAdapter.detect()).toBe(false);
  });

  it("detect() returns true with env vars", () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "key";
    expect(supabaseAdapter.detect()).toBe(true);
  });

  it("returns healthy for 200", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "key";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await supabaseAdapter.check();
    expect(result.status).toBe("healthy");
    expect(result.detail.provider).toBe("supabase");
  });

  it("returns down on error", async () => {
    process.env.SUPABASE_URL = "https://abc.supabase.co";
    process.env.SUPABASE_ANON_KEY = "key";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));
    const result = await supabaseAdapter.check();
    expect(result.status).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// AWS ECS adapter
// ---------------------------------------------------------------------------

describe("aws-ecs adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AWS_ECS_CLUSTER;
    delete process.env.AWS_ECS_SERVICE;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it("detect() returns false without env vars", () => {
    expect(awsEcsAdapter.detect()).toBe(false);
  });

  it("detect() returns true with all required env vars", () => {
    process.env.AWS_ECS_CLUSTER = "my-cluster";
    process.env.AWS_ECS_SERVICE = "my-service";
    process.env.AWS_REGION = "us-east-1";
    expect(awsEcsAdapter.detect()).toBe(true);
  });

  it("returns degraded when missing credentials", async () => {
    process.env.AWS_ECS_CLUSTER = "my-cluster";
    process.env.AWS_ECS_SERVICE = "my-service";
    process.env.AWS_REGION = "us-east-1";
    const result = await awsEcsAdapter.check();
    expect(result.status).toBe("degraded");
    expect(result.detail.error).toContain("Missing AWS_ACCESS_KEY_ID");
  });

  it("returns healthy when service is fully running", async () => {
    process.env.AWS_ECS_CLUSTER = "cluster";
    process.env.AWS_ECS_SERVICE = "svc";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIA";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          services: [
            { status: "ACTIVE", runningCount: 3, desiredCount: 3, deployments: [{}] },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await awsEcsAdapter.check();
    expect(result.status).toBe("healthy");
    expect(result.detail.runningCount).toBe(3);
  });

  it("returns degraded when partially running", async () => {
    process.env.AWS_ECS_CLUSTER = "cluster";
    process.env.AWS_ECS_SERVICE = "svc";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIA";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          services: [{ status: "ACTIVE", runningCount: 1, desiredCount: 3 }],
        }),
        { status: 200 },
      ),
    );
    const result = await awsEcsAdapter.check();
    expect(result.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Fly.io adapter
// ---------------------------------------------------------------------------

describe("fly-io adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
  });

  it("detect() returns false without env vars", () => {
    expect(flyIoAdapter.detect()).toBe(false);
  });

  it("detect() returns true with env vars", () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "my-app";
    expect(flyIoAdapter.detect()).toBe(true);
  });

  it("returns healthy when all machines are started", async () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "my-app";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: "m1", state: "started", region: "iad" },
          { id: "m2", state: "started", region: "lhr" },
        ]),
        { status: 200 },
      ),
    );
    const result = await flyIoAdapter.check();
    expect(result.status).toBe("healthy");
    expect(result.detail.totalMachines).toBe(2);
    expect(result.detail.regions).toEqual(["iad", "lhr"]);
  });

  it("returns degraded when some machines are stopped", async () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "my-app";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: "m1", state: "started", region: "iad" },
          { id: "m2", state: "stopped", region: "lhr" },
        ]),
        { status: 200 },
      ),
    );
    const result = await flyIoAdapter.check();
    expect(result.status).toBe("degraded");
  });

  it("returns down when all machines are stopped", async () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "my-app";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "m1", state: "stopped", region: "iad" }]), {
        status: 200,
      }),
    );
    const result = await flyIoAdapter.check();
    expect(result.status).toBe("down");
  });

  it("returns down on network error", async () => {
    process.env.FLY_API_TOKEN = "tok";
    process.env.FLY_APP_NAME = "my-app";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));
    const result = await flyIoAdapter.check();
    expect(result.status).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// Cloudflare adapter
// ---------------------------------------------------------------------------

describe("cloudflare adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKER_NAME;
  });

  it("detect() returns false without env vars", () => {
    expect(cloudflareAdapter.detect()).toBe(false);
  });

  it("detect() returns true with env vars", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKER_NAME = "worker";
    expect(cloudflareAdapter.detect()).toBe(true);
  });

  it("returns healthy when worker exists", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKER_NAME = "worker";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { id: "worker", modified_on: "2026-04-10T00:00:00Z", etag: "abc" },
        }),
        { status: 200 },
      ),
    );
    const result = await cloudflareAdapter.check();
    expect(result.status).toBe("healthy");
    expect(result.detail.provider).toBe("cloudflare");
  });

  it("returns down for 404", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKER_NAME = "worker";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const result = await cloudflareAdapter.check();
    expect(result.status).toBe("down");
  });

  it("returns degraded when API returns success: false", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKER_NAME = "worker";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "auth error" }],
        }),
        { status: 200 },
      ),
    );
    const result = await cloudflareAdapter.check();
    expect(result.status).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// Adapter interface contract
// ---------------------------------------------------------------------------

describe("adapter interface contract", () => {
  const allAdapters = [
    vercelAdapter,
    supabaseAdapter,
    awsEcsAdapter,
    flyIoAdapter,
    cloudflareAdapter,
  ];

  for (const adapter of allAdapters) {
    it(`${adapter.name} has required properties`, () => {
      expect(typeof adapter.name).toBe("string");
      expect(adapter.name.length).toBeGreaterThan(0);
      expect(typeof adapter.detect).toBe("function");
      expect(typeof adapter.check).toBe("function");
    });
  }
});
