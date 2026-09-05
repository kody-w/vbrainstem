const { test, expect } = require("@playwright/test");
const crypto = require("crypto");

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function hash(space, value) {
  return crypto.createHash("sha256").update(space + "\n").update(
    Buffer.isBuffer(value) ? value : Buffer.from(canonical(value))
  ).digest("hex");
}

function fixture() {
  const keys = crypto.generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ type: "spki", format: "der" });
  const owner = "rappid:@kody-w/vb-test-owner:" + hash("rapp/1:rappid", spki);
  const stream = "rappid:@kody-w/vb-atlas:" + "a".repeat(64);
  const protectedHeader = Buffer.from(canonical({
    alg: "EdDSA", b64: false, crit: ["b64"], kid: owner
  })).toString("base64url");
  const sign = (value) => protectedHeader + ".." + crypto.sign(null,
    Buffer.from(protectedHeader + "." + canonical(value)), keys.privateKey).toString("base64url");
  const frame = {
    spec: "rapp/1", kind: "body.pulse", stream_id: stream, seq: 0,
    utc: "2026-09-05T14:00:00.000Z", payload: { message: "Synthetic public face." },
    prev: null, prev_wave: null
  };
  frame.payload_hash = hash("rapp/1:particle", frame.payload);
  frame.frame_hash = hash("rapp/1:wave", frame);
  frame.sig = sign(frame);
  const registry = {
    schema: "rapp/1-registry", registry_seq: 0,
    entries: [
      { type: "estate_owner", rappid: owner },
      { type: "spki", rappid: owner, spki_der_b64: spki.toString("base64"), deprecated: false },
      { type: "protocol", name: "rapp/1", spec_repo: "https://github.com/kody-w/rapp-1", spec_path: "SPEC.md", spec_hash: "348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384", deprecated: false },
      { type: "kind", kind: "body.pulse", family: "body", deprecated: false },
      { type: "genesis", stream_id: stream, frame_hash: frame.frame_hash, deprecated: false },
      ...["invalid-request", "unknown-session", "refused"].map((code) => ({ type: "error-code", code }))
    ]
  };
  registry.sig = sign(registry);
  const document = { schema: "vbrainstem-dial/1", public_id: stream };
  document.sig = sign(document);
  return { owner, stream, registry, frame, document };
}

test("browser verifies a signed registry, its declared stream and detached signed document", async ({ page }) => {
  await page.goto("/index.html");
  const data = fixture();
  const actual = await page.evaluate(async ({ owner, stream, registry, frames, document, head }) => {
    const verified = await window.VBDialIntegrity.verifyRegistry(registry, owner);
    const chain = await window.VBDialIntegrity.verifyFrameChain(frames, verified, stream, head);
    const signed = await window.VBDialIntegrity.verifySignedDocument(document, verified);
    return {
      owner: verified.owner, head: chain.head.frame_hash, count: chain.count,
      id: signed.public_id, errorCodes: [...verified.errorCodes]
    };
  }, {
    owner: data.owner, stream: data.stream, registry: canonical(data.registry),
    frames: canonical(data.frame) + "\n", document: canonical(data.document), head: data.frame.frame_hash
  });
  expect(actual).toEqual({
    owner: data.owner, head: data.frame.frame_hash, count: 1, id: data.stream,
    errorCodes: ["invalid-request", "unknown-session", "refused"]
  });
});

test("changed signatures, substituted anchors, duplicate keys and empty chains fail closed", async ({ page }) => {
  await page.goto("/index.html");
  const data = fixture();
  function corruptSignature(value) {
    const parts = value.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    return parts.join(".");
  }
  const badRegistry = canonical({ ...data.registry, sig: corruptSignature(data.registry.sig) });
  const badFrame = canonical({ ...data.frame, sig: corruptSignature(data.frame.sig) });
  const badDocument = canonical({ ...data.document, sig: corruptSignature(data.document.sig) });
  const result = await page.evaluate(async ({ owner, stream, registry, frames, head, badRegistry, badFrame, badDocument }) => {
    const verify = window.VBDialIntegrity;
    const rejected = [];
    async function mustReject(name, action) {
      try { await action(); } catch { rejected.push(name); }
    }
    const good = await verify.verifyRegistry(registry, owner);
    await mustReject("registry-signature", () => verify.verifyRegistry(badRegistry, owner));
    await mustReject("frame-signature", () => verify.verifyFrameChain(badFrame, good, stream, head));
    await mustReject("document-signature", () => verify.verifySignedDocument(badDocument, good));
    await mustReject("wrong-anchor", () => verify.verifyRegistry(registry, owner.replace(/.$/, owner.endsWith("0") ? "1" : "0")));
    const unsigned = JSON.parse(registry);
    unsigned.sig = null;
    await mustReject("unsigned", () => verify.verifyRegistry(JSON.stringify(unsigned), owner));
    await mustReject("duplicate-key", () => verify.verifyRegistry(registry.replace("{", '{"registry_seq":99,'), owner));
    await mustReject("empty-chain", () => verify.verifyFrameChain("", good, stream, head));
    await mustReject("foreign-stream", () => verify.verifyFrameChain(frames, good, stream.replace("vb-atlas", "vb-forge"), head));
    await mustReject("wrong-head", () => verify.verifyFrameChain(frames, good, stream, "0".repeat(64)));
    await mustReject("changed-payload", () => verify.verifyFrameChain(frames.replace("Synthetic", "Forged"), good, stream, head));
    return rejected;
  }, {
    owner: data.owner, stream: data.stream, registry: canonical(data.registry),
    frames: canonical(data.frame) + "\n", head: data.frame.frame_hash,
    badRegistry, badFrame, badDocument
  });
  expect(result).toEqual([
    "registry-signature", "frame-signature", "document-signature",
    "wrong-anchor", "unsigned", "duplicate-key", "empty-chain",
    "foreign-stream", "wrong-head", "changed-payload"
  ]);
});

module.exports = { canonical, hash, fixture };
