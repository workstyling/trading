---
name: fullstack-developer
description: |
  Modern full-stack web development with React, Next.js, Node.js, TypeScript, and databases.
  Use when: building web apps, REST/GraphQL APIs, React/Next.js frontends, database schemas,
  authentication flows, deployment pipelines, or integrating third-party services.
  Triggers: React, Next.js, Express, Fastify, REST API, GraphQL, MongoDB, PostgreSQL, Prisma,
  Tailwind, Zustand, React Query, JWT, OAuth, Docker, Vercel, full-stack, web app.
license: MIT
metadata:
  author: awesome-llm-apps
  version: "2.0.0"
---

# Full-Stack Developer

Expert in modern JavaScript/TypeScript full-stack development. Writes production-ready, type-safe code with proper error handling and security.

## Stack

| Layer | Primary | Alternatives |
|-------|---------|--------------|
| Frontend | Next.js 14+ (App Router), React 18+, TypeScript | Remix, Vite+React |
| Styling | Tailwind CSS | CSS Modules, styled-components |
| State | React Query (server), Zustand (client) | SWR, Jotai |
| Forms | react-hook-form + Zod | Formik |
| Backend | Next.js API routes, Express, Fastify | Hono, Elysia |
| ORM | Prisma | Drizzle, Mongoose |
| Database | PostgreSQL, MongoDB | SQLite, Redis |
| Auth | NextAuth.js, JWT | Clerk, Auth0 |
| Deploy | Vercel, Docker | Railway, Fly.io |

## Project Structure

```
src/
├── app/                  # Next.js App Router
│   ├── (auth)/           # Route group — auth pages
│   ├── api/              # API route handlers
│   └── layout.tsx        # Root layout
├── components/
│   ├── ui/               # Base: Button, Input, Modal
│   └── features/         # Feature-specific components
├── lib/
│   ├── db.ts             # Prisma client singleton
│   ├── auth.ts           # Auth configuration
│   └── validations.ts    # Zod schemas
├── hooks/                # Custom React hooks
├── types/                # Shared TypeScript types
└── middleware.ts          # Next.js middleware (auth guards)
```

## Core Patterns

### API Route (Next.js App Router)

```typescript
// app/api/users/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getServerSession } from 'next-auth';

const updateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const result = updateSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: result.error.flatten() },
      { status: 400 }
    );
  }

  const user = await db.user.update({
    where: { id: params.id },
    data: result.data,
    select: { id: true, name: true, email: true, updatedAt: true },
  });

  return NextResponse.json(user);
}
```

### Server Component with Data Fetching

```typescript
// app/posts/page.tsx
import { db } from '@/lib/db';
import { PostCard } from '@/components/features/PostCard';

export default async function PostsPage() {
  const posts = await db.post.findMany({
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { name: true } } },
    take: 20,
  });

  return (
    <main className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Posts</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {posts.map(post => <PostCard key={post.id} post={post} />)}
      </div>
    </main>
  );
}
```

### Client Component with React Query

```typescript
// components/features/UserProfile.tsx
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface User { id: string; name: string; email: string }

export function UserProfile({ userId }: { userId: string }) {
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['user', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => r.json()),
  });

  const mutation = useMutation({
    mutationFn: (data: Partial<User>) =>
      fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user', userId] }),
  });

  if (isLoading) return <div className="animate-pulse h-20 bg-gray-100 rounded" />;
  if (!user) return <div>User not found</div>;

  return (
    <div className="p-4 border rounded-lg">
      <h2 className="text-xl font-bold">{user.name}</h2>
      <p className="text-gray-600">{user.email}</p>
      <button
        onClick={() => mutation.mutate({ name: 'Updated' })}
        disabled={mutation.isPending}
        className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {mutation.isPending ? 'Saving...' : 'Update'}
      </button>
    </div>
  );
}
```

### Prisma Schema Pattern

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([email])
}

model Post {
  id        String   @id @default(cuid())
  title     String
  content   String
  published Boolean  @default(false)
  authorId  String
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@index([authorId])
  @@index([published, createdAt])
}
```

## Security Checklist

- Validate all inputs with Zod `safeParse` (never trust client data)
- Check `session`/`token` before any DB mutation
- Use Prisma `select` to avoid leaking sensitive fields
- Set `httpOnly: true, secure: true, sameSite: 'strict'` on auth cookies
- Rate-limit auth endpoints (use `@upstash/ratelimit` or similar)
- Never expose stack traces — log server-side, return generic errors to client

## Performance Defaults

- Use `next/image` for all images (auto-optimization)
- Dynamic imports for heavy components: `const Chart = dynamic(() => import('./Chart'), { ssr: false })`
- Add `@@index` in Prisma for every foreign key and commonly filtered field
- Use `select` in Prisma queries — never return full rows unnecessarily
- `React.memo` only when profiling confirms re-render cost

## Output Format

Always provide:
1. **File path** for each code block
2. **Complete, runnable code** — no placeholders
3. **Dependencies** (`npm install ...`) if new packages needed
4. **Environment variables** if required
5. **Migration command** if schema changed (`npx prisma migrate dev`)
