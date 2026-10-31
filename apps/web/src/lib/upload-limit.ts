// Hard ceiling for POST /api/upload. The handler buffers the whole file in
// memory before hashing it into the vault, so an uncapped body is both a
// memory- and a disk-fill DoS vector. next.config.ts raises Next's
// middleware body cap (default 10 MB) to this same value so the route's own
// 413 — not a framework truncation error — is what callers see.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// POST /api/mobile/v1/push/register: a registration is four short strings,
// so anything past 2 KB is not one. Lives here because a Next route file may
// export only route fields.
export const MAX_REGISTER_BODY_BYTES = 2048;
