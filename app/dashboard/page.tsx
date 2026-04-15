import { auth } from '@/lib/auth'
import { sql } from '@/lib/neon'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const projects = await sql`
    SELECT id, title, status, created_at
    FROM projects
    WHERE user_id = ${session.user.id}
    ORDER BY created_at DESC
  `

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">SparkBook</h1>
          <span className="text-neutral-400 text-sm">{session.user.email}</span>
        </div>

        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-medium">Your Books</h2>
          <form action="/api/projects" method="POST">
            <button
              type="submit"
              className="px-4 py-2 bg-white text-neutral-900 rounded-lg text-sm font-medium hover:bg-neutral-100 transition"
            >
              + New Book
            </button>
          </form>
        </div>

        {projects.length === 0 ? (
          <div className="text-center py-24 text-neutral-500">
            <p>No books yet.</p>
            <p className="text-sm mt-1">Create one to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {projects.map((p: any) => (
              <a
                key={p.id}
                href={`/project/${p.id}`}
                className="block p-5 bg-neutral-900 rounded-xl hover:bg-neutral-800 transition"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.title}</span>
                  <span className="text-xs text-neutral-500 capitalize">{p.status}</span>
                </div>
                <p className="text-sm text-neutral-500 mt-1">
                  {new Date(p.created_at).toLocaleDateString()}
                </p>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
