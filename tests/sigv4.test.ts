// SigV4 must be exactly right or R2 rejects every request. These expectations
// are AWS's published reference values, not outputs of this implementation:
// - Header signing: the AWS SigV4 test suite (as vendored in boto/botocore,
//   tests/unit/auth/aws4_testsuite), credentials AKIDEXAMPLE.
// - Presigned URL: the S3 "sigv4-query-string-auth" documentation example
//   (also asserted by apache/arrow-rs-object-store).
import { describe, expect, it } from "vitest";
import { canonicalRequest, presignUrl, sha256Hex, signHeaders, stringToSign } from "../src/delivery/sigv4.ts";

const SUITE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const SUITE_SCOPE = { region: "us-east-1", service: "service" };
const SUITE_TIME = new Date("2015-08-30T12:36:00Z");

const authz = (sig: string, signed = "host;x-amz-date") =>
  `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed}, Signature=${sig}`;

describe("SigV4 header signing (AWS test suite)", () => {
  it("get-vanilla: canonical request, string to sign and signature", () => {
    const url = new URL("https://example.amazonaws.com/");
    const { request } = canonicalRequest({
      method: "GET",
      url,
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: sha256Hex(""),
    });
    expect(request).toBe(
      "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(stringToSign("20150830T123600Z", "20150830", SUITE_SCOPE, request)).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    const h = signHeaders(SUITE, SUITE_SCOPE, { method: "GET", url, payloadHash: sha256Hex("") }, SUITE_TIME);
    expect(h.authorization).toBe(authz("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"));
  });

  it("get-vanilla-query-order-key-case: sorts query parameters", () => {
    const url = new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1");
    const h = signHeaders(SUITE, SUITE_SCOPE, { method: "GET", url, payloadHash: sha256Hex("") }, SUITE_TIME);
    expect(h.authorization).toBe(authz("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"));
  });

  it("get-unreserved: leaves unreserved characters unencoded", () => {
    const url = new URL("https://example.amazonaws.com/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    const h = signHeaders(SUITE, SUITE_SCOPE, { method: "GET", url, payloadHash: sha256Hex("") }, SUITE_TIME);
    expect(h.authorization).toBe(authz("07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f"));
  });

  it("post-x-www-form-urlencoded: signs extra headers and the payload hash", () => {
    const url = new URL("https://example.amazonaws.com/");
    const h = signHeaders(
      SUITE,
      SUITE_SCOPE,
      { method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payloadHash: sha256Hex("Param1=value1") },
      SUITE_TIME,
    );
    expect(h.authorization).toBe(authz("ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a", "content-type;host;x-amz-date"));
  });
});

describe("S3 presigned URL (AWS documentation example)", () => {
  it("matches the documented signature exactly", () => {
    const url = presignUrl(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      { region: "us-east-1", service: "s3" },
      "GET",
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      86400,
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  });

  it("refuses expiries outside 1 second to 7 days", () => {
    const args = [{ accessKeyId: "a", secretAccessKey: "b" }, { region: "auto", service: "s3" }, "GET", new URL("https://x.example/y")] as const;
    expect(() => presignUrl(...args, 0, new Date())).toThrow();
    expect(() => presignUrl(...args, 604_801, new Date())).toThrow();
  });
});
