import { afterEach, describe, expect, it, vi } from "vitest";
import { publicTraceIp, runOnlineTrace } from "../globalpingTrace";

describe("online traceroute", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects local and non-IP targets before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const target of ["127.0.0.1", "10.2.3.4", "100.64.0.3", "192.168.1.1", "fe80::1%eth0", "fc00::1", "::ffff:10.0.0.1", "https://example.com"]) {
      await expect(runOnlineTrace({ target, source: "china", protocol: "ICMP" }, vi.fn())).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publicTraceIp(" 2606:4700:4700:0000:0000:0000:0000:1111 ")).toBe("2606:4700:4700::1111");
  });

  it("runs from the requested mainland ASN and polls until the final result", async () => {
    vi.useFakeTimers();
    const endpoint = "https://api.globalping.io/v1/measurements";
    const id = "trace-id";
    const row = {
      probe: { country: "CN", city: "Wuhan", asn: 9808, network: "China Mobile" },
      result: { status: "finished", rawOutput: "1  1.1.1.1  20 ms" },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "in-progress", results: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "finished", results: [row] })));
    vi.stubGlobal("fetch", fetchMock);
    const update = vi.fn();
    const done = runOnlineTrace({ target: "1.1.1.1", source: "mobile", protocol: "TCP" }, update);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(fetchMock).toHaveBeenNthCalledWith(1, endpoint, expect.objectContaining({
      method: "POST", credentials: "omit", redirect: "error",
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      type: "traceroute",
      target: "1.1.1.1",
      limit: 1,
      locations: [{ country: "CN", asn: 9808 }],
      measurementOptions: { protocol: "TCP", port: 443 },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${endpoint}/${id}`, expect.objectContaining({ credentials: "omit" }));
    expect(update).toHaveBeenLastCalledWith({ status: "finished", results: [row] });
  });
});
