// pair-crypto.js — Apple-grade pairing crypto for the RAPP neighborhood.
//
// SPAKE2 (a balanced PAKE, RFC 9382 style, group P-256) so the short pairing
// code is a true password: even an active man-in-the-middle on the signaling
// broker cannot learn the code or the session key, and cannot brute-force it
// offline — every guess needs a live, one-shot interaction. Plus Ed25519
// identity pinning so devices remember each other and re-pair WITHOUT a code
// after the first time (exactly like an iPhone ↔ Apple TV).
//
// All elliptic-curve / hash primitives come from @noble/curves + @noble/hashes
// (audited). The SPAKE2 and identity composition here is small and is validated
// by security-property tests (test_spake2.mjs): same code ⇒ agree; different
// code ⇒ fail; independent ephemerals (a MITM) ⇒ keys differ ⇒ confirmation
// fails. Roles are fixed: the code GENERATOR is A (uses M), the code ENTERER
// is B (uses N).
//
// ESM module. Pin exact versions for supply-chain stability.
import { p256, hashToCurve } from 'https://esm.sh/@noble/curves@1.6.0/p256';
import { ed25519 } from 'https://esm.sh/@noble/curves@1.6.0/ed25519';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.5.0/sha256';
import { hmac } from 'https://esm.sh/@noble/hashes@1.5.0/hmac';

const P = p256.ProjectivePoint;
const N_ORDER = p256.CURVE.n;
const enc = new TextEncoder();

// Nothing-up-my-sleeve generators M, N via hash-to-curve (RFC 9380). Independent
// of the base point with unknown discrete-log relationship — the SPAKE2 masks.
const M = hashToCurve(enc.encode('RAPP-SPAKE2/1 point M'));
const N = hashToCurve(enc.encode('RAPP-SPAKE2/1 point N'));
function asPoint(h) { return (h && h.toAffine) ? P.fromAffine(h.toAffine()) : h; }
const PM = asPoint(M), PN = asPoint(N);

// ── helpers ──
function b2n(b) { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; }
function n2b(n, len) { const o = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; }
function mod(a, m) { return ((a % m) + m) % m; }
function randScalar() {
  while (true) {
    const r = mod(b2n(crypto.getRandomValues(new Uint8Array(48))), N_ORDER);
    if (r !== 0n) return r;
  }
}
function cat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const o = new Uint8Array(len); let p = 0;
  for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
}
function lenPrefixed(b) { const l = new Uint8Array(8); let n = BigInt(b.length); for (let i = 0; i < 8; i++) { l[i] = Number(n & 0xffn); n >>= 8n; } return cat(l, b); } // 8-byte LE length
function ctEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }

// Password scalar w = H(code) mod n (nonzero).
function pwScalar(code) {
  const w = mod(b2n(sha256(enc.encode('RAPP-SPAKE2/1 pw:' + String(code)))), N_ORDER);
  return w === 0n ? 1n : w;
}

// ── SPAKE2 ──
// role: 'A' (code generator, mask M) or 'B' (code enterer, mask N).
// Returns { msg: Uint8Array (our public element), _state }.
export function spake2Start(role, code) {
  const w = pwScalar(code);
  const x = randScalar();
  const mask = (role === 'A') ? PM : PN;
  const T = P.BASE.multiply(x).add(mask.multiply(w));   // X = x·G + w·M  (or Y = y·G + w·N)
  return { msg: T.toRawBytes(false), _state: { role, w, x, mine: T.toRawBytes(false) } };
}

// Finish with the peer's message. Returns { key, macMine, verify(peerMac) }.
export function spake2Finish(state, peerMsg) {
  const { role, w, x, mine } = state;
  const peer = P.fromHex(peerMsg);
  const peerMask = (role === 'A') ? PN : PM;            // A removes N from Y; B removes M from X
  const K = peer.add(peerMask.multiply(w).negate()).multiply(x);   // K = x·(peer - w·peerMask)
  const Kb = K.toRawBytes(false);
  // Deterministic A/B ordering so both sides hash the same transcript.
  const A = (role === 'A') ? mine : peerMsg;
  const B = (role === 'A') ? peerMsg : mine;
  const TT = cat(
    lenPrefixed(enc.encode('vbrainstem')),  // idA
    lenPrefixed(enc.encode('rapp-host')),   // idB
    lenPrefixed(A), lenPrefixed(B),
    lenPrefixed(Kb), lenPrefixed(n2b(w, 32))
  );
  const Kmain = sha256(TT);
  const Ke = Kmain.slice(0, 16);
  const Ka = Kmain.slice(16, 32);
  const KcA = hmac(sha256, Ka, enc.encode('ConfirmA'));
  const KcB = hmac(sha256, Ka, enc.encode('ConfirmB'));
  const macA = hmac(sha256, KcA, TT);
  const macB = hmac(sha256, KcB, TT);
  const macMine = (role === 'A') ? macA : macB;
  const macPeer = (role === 'A') ? macB : macA;
  // Session key: HKDF-ish expand of Ke.
  const sessionKey = hmac(sha256, Ke, enc.encode('RAPP-session-key/1'));
  return {
    key: sessionKey,               // 32 bytes — the sealed-channel key (hex it for rapp-sealed)
    keyHex: hex(sessionKey),
    macMine,
    verify(peerMac) { return ctEqual(peerMac, macPeer); }
  };
}

// ── Ed25519 identity pinning ──
// Long-term identity keypair, persisted (private stays local). Peers store each
// other's public key on first pair; later connects prove identity by signature,
// so no code is needed again.
export function loadOrCreateIdentity(storageKey) {
  let priv = null;
  try {
    const stored = localStorage.getItem(storageKey || 'rapp_identity_sk');
    if (stored) priv = fromHex(stored);
  } catch (e) { }
  if (!priv || priv.length !== 32) {
    priv = ed25519.utils.randomPrivateKey();
    try { localStorage.setItem(storageKey || 'rapp_identity_sk', hex(priv)); } catch (e) { }
  }
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub, pubHex: hex(pub) };
}
export function idSign(priv, messageBytes) { return ed25519.sign(messageBytes, priv); }
export function idVerify(pubHex, sig, messageBytes) {
  try { return ed25519.verify(sig, messageBytes, fromHex(pubHex)); } catch (e) { return false; }
}

export const _util = { hex, fromHex, enc, cat };
