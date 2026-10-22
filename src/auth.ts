import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import {
  createSession,
  findActiveAccountByUsername,
  isSessionActive,
  revokeSession
} from "@/modules/auth/repository";
import { verifyPassword } from "@/modules/auth/passwords";

const credentialsSchema = z.object({
  username: z.string().trim().min(1, "请输入账号").max(64),
  password: z.string().min(1, "请输入密码").max(128),
  entryRole: z.enum(["admin", "expert"])
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60
  },
  pages: {
    signIn: "/"
  },
  providers: [
    Credentials({
      name: "账号密码",
      credentials: {
        username: { label: "账号", type: "text" },
        password: { label: "密码", type: "password" },
        entryRole: { label: "入口角色", type: "text" }
      },
      async authorize(credentials) {
        const input = credentialsSchema.safeParse(credentials);
        if (!input.success) {
          return null;
        }

        const account = await findActiveAccountByUsername(input.data.username);
        if (!account || account.role !== input.data.entryRole) {
          return null;
        }

        const passwordMatches = await verifyPassword(input.data.password, account.password_hash);
        if (!passwordMatches) {
          return null;
        }

        const session = await createSession(account.id);
        return {
          id: account.id,
          // The workspace account menu identifies the signed-in account by its login name.
          name: account.username,
          role: account.role,
          sessionId: session.id
        };
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.name = user.name;
        token.role = user.role;
        token.sid = user.sessionId;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.name = typeof token.name === "string" ? token.name : "";
        session.user.role = token.role === "admin" ? "admin" : "expert";
        session.user.sessionId = typeof token.sid === "string" ? token.sid : "";
      }

      return session;
    },
    async authorized({ auth: currentAuth, request }) {
      if (!request.nextUrl.pathname.startsWith("/workspace")) {
        return true;
      }

      return Boolean(currentAuth?.user?.id);
    }
  },
  events: {
    async signOut(message) {
      if ("token" in message && typeof message.token?.sid === "string") {
        await revokeSession(message.token.sid);
      }
    }
  }
});

export async function getVerifiedSession() {
  const session = await auth();
  if (!session?.user?.id || !session.user.sessionId) {
    return null;
  }

  const active = await isSessionActive(session.user.sessionId, session.user.id);
  return active ? session : null;
}
