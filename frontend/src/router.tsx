import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { AppShell } from '@/components/shell/AppShell'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { NotFound } from '@/features/stages/NotFound'

const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/projects" replace /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <Navigate to="script" replace /> },
          {
            path: 'create',
            lazy: async () => ({ Component: (await import('@/features/quick/QuickCreatePage')).QuickCreatePage }),
          },
          {
            // not :projectId, so the top bar stays out of studio mode on the progress screen
            path: 'quick/:quickId',
            lazy: async () => ({ Component: (await import('@/features/quick/QuickProgressPage')).QuickProgressPage }),
          },
          {
            path: 'projects/:projectId/:stage',
            lazy: async () => ({ Component: (await import('@/features/workspace/WorkspacePage')).WorkspacePage }),
          },
        ],
      },
    ],
  },
]

// Component gallery for visual QA; never shipped in production bundles.
if (import.meta.env.DEV) {
  routes.push({
    path: '/dev/ui',
    lazy: async () => ({ Component: (await import('@/features/dev/DevUiPage')).DevUiPage }),
  })
}

routes.push({ path: '*', element: <NotFound /> })

export const router = createBrowserRouter(routes)
