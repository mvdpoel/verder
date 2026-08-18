// Hard ceiling for POST /api/upload. The handler buffers the whole file in
// memory before hashing it into the vault, so an uncapped body is both a
// memory- and a disk-fill DoS vector. next.config.ts raises Next's
// middleware body cap (default 10 MB) to this same value so the route's own
// 413 — not a framework truncation error — is what callers see.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
