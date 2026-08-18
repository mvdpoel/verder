import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const isPublic = req.nextUrl.pathname.startsWith("/login")
    || req.nextUrl.pathname.startsWith("/api/auth");
  // better-auth prefixes the cookie with __Secure- when baseURL is https.
  const hasSession = req.cookies.has("better-auth.session_token")
    || req.cookies.has("__Secure-better-auth.session_token");
  if (!isPublic && !hasSession)
    return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next|favicon).*)"] };
