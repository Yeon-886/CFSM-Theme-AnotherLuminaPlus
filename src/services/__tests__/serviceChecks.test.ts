import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_CATEGORIES,
  ServiceSnapshotSchema,
  fetchServiceSnapshot,
  getNodeServiceOptions,
  runServiceCheck,
} from "../serviceChecks";

const snapshot = {
  version: 1 as const,
  source: "Tokyo VPS",
  nodeIds: ["tokyo-vps"],
  categories: [...SERVICE_CATEGORIES],
  results: {},
};

describe("VPS service checks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the service capability snapshot and maps it to a node", () => {
    const parsed = ServiceSnapshotSchema.parse(snapshot);
    expect(getNodeServiceOptions([
      { snapshotUrl: "https://probe.example.com/route/snapshot.json", snapshot: parsed },
    ], "tokyo-vps")).toMatchObject([{ source: "Tokyo VPS", categories: SERVICE_CATEGORIES }]);
    expect(getNodeServiceOptions([
      { snapshotUrl: "https://probe.example.com/route/snapshot.json", snapshot: parsed },
    ], "other")).toEqual([]);
  });

  it("reads service capabilities without credentials and posts only the selected category", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, results: {
        ai: { checkedAt: "2026-11-27T10:00:00Z", egressIp: "203.0.113.10", results: [] },
      } })));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://probe.example.com/route/snapshot.json";
    await expect(fetchServiceSnapshot(url)).resolves.toMatchObject({ source: "Tokyo VPS" });
    await expect(runServiceCheck({ snapshotUrl: url, category: "ai" }, "z".repeat(43))).resolves.toMatchObject({
      results: { ai: { egressIp: "203.0.113.10" } },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, new URL("https://probe.example.com/route/service-snapshot.json"), expect.objectContaining({
      credentials: "omit", redirect: "error",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, new URL("https://probe.example.com/route/service-check"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ category: "ai" }),
      credentials: "omit",
      redirect: "error",
    }));
  });
});
