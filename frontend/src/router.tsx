import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { AppShell } from '@/components/shell/AppShell'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { NotFound } from '@/features/stages/NotFound'

const page = (path: string, load: () => Promise<React.ReactElement>): RouteObject => ({
  path,
  lazy: async () => ({ element: await load() }),
})

// Everything behind the rail. Exported so tests can mount the real route table.
export const shellRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('@/features/home/HomePage')).HomePage }) },

  // Video
  page('video/quick', async () => {
    const { QuickCreatePage } = await import('@/features/quick/QuickCreatePage')
    return <QuickCreatePage />
  }),
  page('video/create', async () => {
    const { VideoCreatePage } = await import('@/features/video/VideoCreatePage')
    return <VideoCreatePage />
  }),
  { path: 'video/projects', element: <ProjectsPage /> },
  page('video/templates', async () => {
    const { TemplatesPage } = await import('@/features/templates/TemplatesPage')
    return <TemplatesPage type="video" />
  }),
  page('video/upscale', async () => {
    const { UpscalePickPage } = await import('@/features/upscale/UpscalePickPage')
    return <UpscalePickPage kind="video" />
  }),
  page('video/library', async () => {
    const { LibraryPage } = await import('@/features/library/LibraryPage')
    return <LibraryPage kind="video" />
  }),

  // Image
  page('image/generate', async () => {
    const { ImageGeneratePage } = await import('@/features/image/ImageGeneratePage')
    return <ImageGeneratePage />
  }),
  page('image/edit', async () => {
    const { ImageEditPage } = await import('@/features/image/ImageEditPage')
    return <ImageEditPage />
  }),
  page('image/references', async () => {
    const { ImageReferencesPage } = await import('@/features/image/ImageReferencesPage')
    return <ImageReferencesPage />
  }),
  page('image/templates', async () => {
    const { TemplatesPage } = await import('@/features/templates/TemplatesPage')
    return <TemplatesPage type="image" />
  }),
  page('image/upscale', async () => {
    const { UpscalePickPage } = await import('@/features/upscale/UpscalePickPage')
    return <UpscalePickPage kind="image" />
  }),
  page('image/library', async () => {
    const { LibraryPage } = await import('@/features/library/LibraryPage')
    return <LibraryPage kind="image" />
  }),
  { path: 'image', element: <Navigate to="/image/generate" replace /> },
  { path: 'video', element: <Navigate to="/video/quick" replace /> },

  page('assets', async () => {
    const { AssetsPage } = await import('@/features/assets/AssetsPage')
    return <AssetsPage />
  }),
  page('queue', async () => {
    const { QueuePage } = await import('@/features/queue/QueuePage')
    return <QueuePage />
  }),
  page('settings', async () => {
    const { SettingsPage } = await import('@/features/settings/SettingsPage')
    return <SettingsPage />
  }),

  // Older addresses people have bookmarked
  { path: 'projects', element: <Navigate to="/video/projects" replace /> },
  { path: 'create', element: <Navigate to="/video/quick" replace /> },

  { path: 'projects/:projectId', element: <Navigate to="script" replace /> },
  {
    // not :projectId, so the top bar stays out of studio mode on the progress screen
    path: 'quick/:quickId',
    lazy: async () => ({ Component: (await import('@/features/quick/QuickProgressPage')).QuickProgressPage }),
  },
  {
    path: 'projects/:projectId/:stage',
    lazy: async () => ({ Component: (await import('@/features/workspace/WorkspacePage')).WorkspacePage }),
  },
]

const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [{ element: <AppShell />, children: shellRoutes }],
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
