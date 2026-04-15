import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sql } from '@/lib/neon'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rows = (await sql`
    INSERT INTO projects (user_id, title, status)
    VALUES (${session.user.id}, 'My Book', 'created')
    RETURNING id
  `) as { id: string }[]

  return NextResponse.redirect(
    new URL(`/project/${rows[0].id}`, req.nextUrl.origin)
  )
}
