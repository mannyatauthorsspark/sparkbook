import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { sql } from '@/lib/neon'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: [
            'openid',
            'email',
            'profile',
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/youtube.force-ssl',
          ].join(' '),
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // Upsert user in Neon on every sign-in
      await sql`
        INSERT INTO users (email)
        VALUES (${user.email})
        ON CONFLICT (email) DO NOTHING
      `
      return true
    },
    async session({ session, token }) {
      // Read from JWT — no DB call on every request
      session.user.id = token.userId as string
      session.user.paidAt = token.paidAt as string | null
      session.accessToken = token.accessToken as string
      session.refreshToken = token.refreshToken as string
      return session
    },
    async jwt({ token, account, user }) {
      if (account) {
        token.accessToken = account.access_token
        token.refreshToken = account.refresh_token
      }
      // Fetch user data from DB once at sign-in, store in token
      if (user?.email && !token.userId) {
        const [dbUser] = await sql`
          SELECT id, paid_at FROM users WHERE email = ${user.email}
        `
        token.userId = dbUser?.id
        token.paidAt = dbUser?.paid_at ?? null
      }
      return token
    },
  },
})
