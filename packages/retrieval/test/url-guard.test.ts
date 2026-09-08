import { describe, expect, it } from "vitest";
import { assertFetchable, isPrivateAddress } from "../src/url-guard";

/** DNS never happens in the suite; every hostname resolves to whatever the test says. */
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

describe("SSRF guard", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://127.0.0.1:8099/acme/",
    "http://localhost:8099/acme/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://0.0.0.0/",
  ];

  it.each(blocked)("rejects %s when ALLOW_PRIVATE_HOSTS is off", async (url) => {
    await expect(
      assertFetchable(url, { allowPrivateHosts: false, resolveHostname: resolvesTo("127.0.0.1") }),
    ).rejects.toThrow(/private address|Refusing/);
  });

  it.each(blocked)("allows %s when ALLOW_PRIVATE_HOSTS is on", async (url) => {
    await expect(assertFetchable(url, { allowPrivateHosts: true })).resolves.toBeInstanceOf(URL);
  });

  it("allows an ordinary public site", async () => {
    const url = await assertFetchable("https://meridian.test/handbook", {
      resolveHostname: resolvesTo("93.184.216.34"),
    });
    expect(url.hostname).toBe("meridian.test");
  });

  it("checks the resolved address, not the hostname", async () => {
    // The DNS-rebinding case: a perfectly ordinary name with an A record aimed at the metadata
    // endpoint. A guard that only inspected the hostname would wave this straight through.
    await expect(
      assertFetchable("https://totally-normal.test/", { resolveHostname: resolvesTo("169.254.169.254") }),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("rejects when any one of several resolved addresses is private", async () => {
    await expect(
      assertFetchable("https://mixed.test/", { resolveHostname: resolvesTo("93.184.216.34", "10.1.2.3") }),
    ).rejects.toThrow(/10\.1\.2\.3/);
  });

  it("rejects an IPv4-mapped IPv6 loopback", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it.each(["file:///etc/passwd", "gopher://evil.test/", "ftp://evil.test/"])("refuses protocol in %s", async (url) => {
    await expect(assertFetchable(url)).rejects.toThrow(/Refusing protocol/);
  });

  it("rejects something that is not a URL at all", async () => {
    await expect(assertFetchable("not a url")).rejects.toThrow(/Not a URL/);
  });

  it("reports a hostname that does not resolve as unreachable", async () => {
    await expect(assertFetchable("https://nowhere.test/", { resolveHostname: resolvesTo() })).rejects.toMatchObject({
      code: "COMPANY_UNREACHABLE",
    });
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700::1111"])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each(["10.0.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "fd00::1", "fe80::1"])(
    "treats %s as private",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  it("refuses an address it cannot parse rather than assuming it is public", () => {
    expect(isPrivateAddress("999.999.999.999")).toBe(true);
  });
});
