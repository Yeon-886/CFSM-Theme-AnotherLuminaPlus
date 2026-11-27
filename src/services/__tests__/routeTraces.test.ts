import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeThemeSettings } from "@/utils/themeSettings";
import { parseRouteTraceUrls } from "@/utils/routeTraceUrls";
import {
  fetchRouteTraceSnapshot,
  getNodeRouteOptions,
  getNodeRouteTraces,
  measureRouteTrace,
  RouteTraceSnapshotSchema,
} from "../routeTraces";

const trace = {
  nodeId: "tokyo-vps",
  direction: "forward",
  family: 6,
  destination: "Tokyo VPS",
  targetIp: "2001:db8:1::10",
  protocol: "tcp",
  port: 443,
  measuredAt: "2026-11-27T09:10:00Z",
  status: "incomplete",
  hops: [{ ttl: 1, ip: "2001:db8::1", rttMs: 1.25 }, { ttl: 2 }],
} as const;

describe("route trace snapshots", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts public URLs and leaves older configs with no routes enabled", () => {
    const input = "  /routes/a.json\r\nhttps://routes.example.com/b.json\n/routes/a.json";
    expect(parseRouteTraceUrls(input)).toEqual(["/routes/a.json", "https://routes.example.com/b.json"]);
    expect(normalizeThemeSettings(undefined).routeTraceUrls).toBe("");
    for (const url of ["//example.com", "/.//example.com", "https://secret@example.com/r.json", "https://example.com/r?key=x", "http://example.com/r"]) {
      expect(parseRouteTraceUrls(url)).toBeNull();
    }
  });

  it("uses the latest equivalent trace for the requested server and keeps the opposite direction separate", () => {
    const snapshots = [
      RouteTraceSnapshotSchema.parse({ version: 1, source: "Chengdu Mobile", traces: [trace] }),
      RouteTraceSnapshotSchema.parse({ version: 1, source: "Chengdu Mobile", traces: [
        { ...trace, measuredAt: "2026-11-27T17:15:00+08:00", status: "reached" },
        { ...trace, nodeId: "different-node" },
      ] }),
      RouteTraceSnapshotSchema.parse({ version: 1, source: "Tokyo VPS", traces: [
        { ...trace, direction: "return", destination: "Chengdu Mobile", targetIp: "2001:db8:2::20" },
      ] }),
    ];
    expect(getNodeRouteTraces(snapshots, "tokyo-vps")).toMatchObject([
      { direction: "forward", source: "Chengdu Mobile", status: "reached", hops: [{ ttl: 1 }, { ttl: 2 }] },
      { direction: "return", source: "Tokyo VPS", destination: "Chengdu Mobile" },
    ]);
  });

  it("reads a public feed without cookies and rejects an inconsistent IP family", async () => {
    const makePayload = (family: number) => new Response(JSON.stringify({
      version: 1, source: "Chengdu Mobile", traces: [{ ...trace, family }],
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(makePayload(6)).mockResolvedValueOnce(makePayload(4));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://routes.example.com/a.json";

    await expect(fetchRouteTraceSnapshot(url)).resolves.toMatchObject({ traces: [{ family: 6 }] });
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    }));
    await expect(fetchRouteTraceSnapshot(url)).rejects.toThrow("Invalid route family");
  });

  it("offers a configured probe for the current node before it has a measurement", () => {
    const id = "a".repeat(32);
    const snapshot = RouteTraceSnapshotSchema.parse({
      version: 1,
      source: "Chengdu Mobile",
      traces: [],
      probeTargets: [{ ...trace, id }],
    });
    const live = { snapshotUrl: "https://routes.example.com/probe/snapshot.json", snapshot };
    expect(getNodeRouteOptions([live], "tokyo-vps")).toMatchObject([
      { direction: "forward", family: 6, probe: { snapshotUrl: live.snapshotUrl, targetId: id } },
    ]);
    expect(getNodeRouteOptions([live], "another-node")).toEqual([]);
    expect(getNodeRouteOptions([{ ...live, snapshotUrl: "https://routes.example.com/static.json" }], "tokyo-vps")).toEqual([]);
  });

  it("sends the preset ID and dedicated token only to the sibling measurement endpoint", async () => {
    const id = "a".repeat(32);
    const token = "test-token-".repeat(4);
    const snapshot = {
      version: 1,
      source: "Chengdu Mobile",
      traces: [trace],
      probeTargets: [{ ...trace, id }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    const probe = { snapshotUrl: "https://routes.example.com/probe/snapshot.json", targetId: id };
    await expect(measureRouteTrace(probe, token)).resolves.toMatchObject({ traces: [trace] });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://routes.example.com/probe/measure"), expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
      credentials: "omit",
      redirect: "error",
    }));
    await expect(measureRouteTrace({ ...probe, snapshotUrl: "http://routes.example.com/snapshot.json" }, token)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
