import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role: "admin" | "expert";
    sessionId: string;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: "admin" | "expert";
      sessionId: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "admin" | "expert";
    sid?: string;
  }
}
