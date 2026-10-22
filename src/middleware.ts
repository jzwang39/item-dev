import { NextResponse, type NextRequest } from "next/server";

// Middleware runs in the Edge runtime. Full session validation happens in the
// workspace Server Component, where MySQL-backed revocation can be checked.
export function middleware(request: NextRequest) {
  const hasSessionCookie =
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token");

  if (!hasSessionCookie) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/workspace/:path*"]
};
