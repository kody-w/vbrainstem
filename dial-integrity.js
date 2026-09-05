/* Browser verifier for the signed, canonical dial-pair publication profile.
 * RAPP/1 remains the authority. Unsupported registry transitions fail closed.
 */
(() => {
  "use strict";

  const SPEC_HASH = "348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384";
  const HEX = /^[0-9a-f]{64}$/;
  const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const FRAME_KEYS = ["spec", "kind", "stream_id", "seq", "utc", "payload", "payload_hash", "frame_hash", "prev", "prev_wave", "sig"];
  const ENTRY_KEYS = {
    estate_owner: ["type", "rappid"],
    spki: ["type", "rappid", "spki_der_b64", "deprecated"],
    protocol: ["type", "name", "spec_repo", "spec_path", "spec_hash", "deprecated"],
    kind: ["type", "kind", "family", "deprecated"],
    genesis: ["type", "stream_id", "frame_hash", "deprecated"]
  };

  function requireValue(condition, message) {
    if (!condition) throw new Error("Publication verification failed: " + message);
  }

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  }

  function uint53(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function rappid(value) {
    if (typeof value !== "string") return false;
    const match = value.match(/^rappid:@([^/]+)\/([^:]+):([0-9a-f]{64})$/);
    return Boolean(match && match[1].length <= 39 && match[2].length <= 100 && LABEL.test(match[1]) && LABEL.test(match[2]));
  }

  function streamFamily(value) {
    if (rappid(value)) return "body";
    if (typeof value !== "string") return null;
    const at = value.lastIndexOf(":");
    const instance = value.slice(at + 1);
    if (rappid(value.slice(0, at)) && instance.length <= 64 && LABEL.test(instance)) return "memory";
    if (value.startsWith("net:") && LABEL.test(value.slice(4))) return "swarm";
    return null;
  }

  function validString(value) {
    requireValue(value.normalize("NFC") === value, "non-NFC string");
    for (let index = 0; index < value.length; index += 1) {
      const char = value.charCodeAt(index);
      if (char >= 0xd800 && char <= 0xdbff) {
        const next = value.charCodeAt(++index);
        requireValue(next >= 0xdc00 && next <= 0xdfff, "unpaired Unicode surrogate");
      } else {
        requireValue(char < 0xdc00 || char > 0xdfff, "unpaired Unicode surrogate");
      }
    }
  }

  function canonical(value, depth = 0) {
    requireValue(depth <= 64, "document exceeds nesting limit");
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "string") {
      validString(value);
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      requireValue(Number.isFinite(value), "non-finite number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return "[" + value.map((item) => canonical(item, depth + 1)).join(",") + "]";
    requireValue(object(value), "not an I-JSON value");
    return "{" + Object.keys(value).sort().map((key) => {
      validString(key);
      return JSON.stringify(key) + ":" + canonical(value[key], depth + 1);
    }).join(",") + "}";
  }

  function parseCanonical(text) {
    requireValue(typeof text === "string" && encoder.encode(text).length <= 1024 * 1024, "document is missing or too large");
    const value = JSON.parse(text);
    const bytes = canonical(value);
    // Exact canonical files make duplicate keys and lossy number parsing detectable.
    requireValue(text === bytes || text === bytes + "\n", "noncanonical or duplicate-key JSON");
    return value;
  }

  async function hashBytes(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function hash(space, value) {
    const prefix = encoder.encode(space + "\n");
    const payload = value instanceof Uint8Array ? value : encoder.encode(canonical(value));
    const bytes = new Uint8Array(prefix.length + payload.length);
    bytes.set(prefix);
    bytes.set(payload, prefix.length);
    return hashBytes(bytes);
  }

  function base64(value, url = false) {
    requireValue(typeof value === "string" && (url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(value), "invalid base64");
    const normalized = url ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
    const binary = atob(normalized);
    const encoded = btoa(binary);
    requireValue((url ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded) === value, "noncanonical base64");
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function verifySignature(value, signature, registry) {
    requireValue(typeof signature === "string", "missing detached signature");
    const parts = signature.split(".");
    requireValue(parts.length === 3 && parts[1] === "", "signature is not detached JWS");
    const protectedText = decoder.decode(base64(parts[0], true));
    const header = parseCanonical(protectedText);
    requireValue(exactKeys(header, ["alg", "b64", "crit", "kid"]), "invalid JWS protected header");
    requireValue(header.alg === "EdDSA" && header.b64 === false &&
      Array.isArray(header.crit) && header.crit.length === 1 && header.crit[0] === "b64", "unsupported JWS algorithm or encoding");
    requireValue(header.kid === registry.owner, "signer is not the expected publisher");
    const keyBytes = registry.keys.get(header.kid);
    requireValue(keyBytes, "publisher key is not registered");
    const signatureBytes = base64(parts[2], true);
    requireValue(signatureBytes.length === 64, "invalid Ed25519 signature length");
    const key = await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    const good = await crypto.subtle.verify(
      { name: "Ed25519" }, key, signatureBytes, encoder.encode(parts[0] + "." + canonical(value))
    );
    requireValue(good, "invalid signature");
  }

  async function verifyRegistry(text, expectedOwner) {
    requireValue(rappid(expectedOwner), "an independently supplied publisher RAPPID is required");
    const document = parseCanonical(text);
    requireValue(object(document) && document.schema === "rapp/1-registry" && uint53(document.registry_seq), "invalid registry envelope");
    requireValue(Array.isArray(document.entries) && document.entries.length > 0 && document.entries.length <= 1024, "missing or oversized registry entries");
    const keys = new Map();
    const kinds = new Map();
    const genesis = new Map();
    let owner = null;
    let protocol = false;
    for (const entry of document.entries) {
      requireValue(object(entry) && Object.hasOwn(ENTRY_KEYS, entry.type) && exactKeys(entry, ENTRY_KEYS[entry.type]), "unsupported registry entry or transition");
      if (entry.type !== "estate_owner") requireValue(typeof entry.deprecated === "boolean", "invalid deprecated flag");
      if (entry.type === "estate_owner") {
        requireValue(owner === null && rappid(entry.rappid), "duplicate or invalid estate owner");
        owner = entry.rappid;
      } else if (entry.type === "spki") {
        requireValue(rappid(entry.rappid) && !keys.has(entry.rappid), "invalid or duplicate SPKI entry");
        const bytes = base64(entry.spki_der_b64);
        requireValue(await hash("rapp/1:rappid", bytes) === entry.rappid.split(":").pop(), "SPKI fingerprint does not match RAPPID");
        if (!entry.deprecated) keys.set(entry.rappid, bytes);
      } else if (entry.type === "kind") {
        const labels = typeof entry.kind === "string" ? entry.kind.split(".") : [];
        requireValue(labels.length === 2 && labels.every((part) => part.length <= 64 && LABEL.test(part)) &&
          ["body", "memory", "swarm"].includes(entry.family) && !kinds.has(entry.kind), "invalid or duplicate kind binding");
        kinds.set(entry.kind, entry.family);
      } else if (entry.type === "genesis") {
        requireValue(streamFamily(entry.stream_id) && HEX.test(entry.frame_hash), "invalid genesis");
        requireValue(!entry.deprecated && !genesis.has(entry.stream_id), "re-genesis requires a newer verifier");
        genesis.set(entry.stream_id, entry.frame_hash);
      } else if (entry.type === "protocol" && entry.name === "rapp/1" && !entry.deprecated) {
        requireValue(!protocol && entry.spec_repo === "https://github.com/kody-w/rapp-1" &&
          entry.spec_path === "SPEC.md" && entry.spec_hash === SPEC_HASH, "unrecognized RAPP/1 authority pin");
        protocol = true;
      }
    }
    requireValue(owner === expectedOwner && keys.has(owner) && protocol, "registry does not match the trusted publisher or protocol");
    const verified = { owner, keys, kinds, genesis, document };
    const { sig, ...unsigned } = document;
    await verifySignature(unsigned, sig, verified);
    return verified;
  }

  async function verifySignedDocument(text, registry) {
    const document = parseCanonical(text);
    requireValue(object(document), "signed document is not an object");
    const { sig, ...unsigned } = document;
    await verifySignature(unsigned, sig, registry);
    return document;
  }

  async function verifyFrameChain(text, registry, streamId, expectedHead) {
    requireValue(typeof text === "string" && encoder.encode(text).length <= 4 * 1024 * 1024, "chain is missing or too large");
    requireValue(streamFamily(streamId) && HEX.test(expectedHead), "invalid expected stream or head");
    const lines = text.split("\n").filter((line) => line.length);
    requireValue(lines.length > 0 && lines.length <= 256, "chain is empty or exceeds the profile limit");
    let head = null;
    for (const line of lines) {
      const frame = parseCanonical(line);
      requireValue(exactKeys(frame, FRAME_KEYS), "frame must have exactly eleven keys");
      requireValue(frame.spec === "rapp/1" && frame.stream_id === streamId, "frame stream binding mismatch");
      const family = registry.kinds.get(frame.kind);
      requireValue(family && family === streamFamily(streamId), "kind is not registered for this stream family");
      requireValue(uint53(frame.seq) && object(frame.payload) && HEX.test(frame.payload_hash) && HEX.test(frame.frame_hash), "invalid frame types");
      requireValue(typeof frame.utc === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(frame.utc) &&
        Number.isFinite(Date.parse(frame.utc)) && new Date(frame.utc).toISOString() === frame.utc, "invalid UTC timestamp");
      requireValue(await hash("rapp/1:particle", frame.payload) === frame.payload_hash, "particle hash mismatch");
      const { frame_hash: wave, sig, ...preimage } = frame;
      requireValue(await hash("rapp/1:wave", preimage) === wave, "wave hash mismatch");
      requireValue(frame.seq === (head ? head.seq + 1 : 0) && frame.prev === (head ? head.payload_hash : null), "chain link mismatch");
      requireValue(!head || frame.utc >= head.utc, "clock moved backwards within stream");
      requireValue(frame.prev_wave === (family === "swarm" && head ? head.frame_hash : null), "wave chain link mismatch");
      requireValue(head || registry.genesis.get(streamId) === frame.frame_hash, "unregistered genesis");
      const { sig: ignored, ...unsigned } = frame;
      await verifySignature(unsigned, sig, registry);
      head = frame;
    }
    requireValue(head.frame_hash === expectedHead, "head does not match the signed publication");
    return { head, count: lines.length };
  }

  window.VBDialIntegrity = Object.freeze({
    canonical, hash, hashBytes, parseCanonical, rappid,
    verifyRegistry, verifySignedDocument, verifyFrameChain
  });
})();
