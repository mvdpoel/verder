import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const isPublic = req.nextUrl.pathname.startsWith("/login")
    || req.nextUrl.pathname.startsWith("/api/auth")
    // The apple-app-site-association file: iOS fetches it with no cookie, and
    // a redirect to /login makes the passkey association fail.
    || req.nextUrl.pathname.startsWith("/.well-known/");
  // better-auth prefixes the cookie with __Secure- when baseURL is https.
  const hasSession = req.cookies.has("better-auth.session_token")
    || req.cookies.has("__Secure-better-auth.session_token");
  if (!isPublic && !hasSession) {
    // A native client follows a redirect and reads the login page's 200 as
    // success — a queued scan would be marked sent and deleted. The mobile
    // API therefore answers with a status the app can act on.
    if (req.nextUrl.pathname.startsWith("/api/mobile/"))
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next|favicon).*)"] };
