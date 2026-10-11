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
  page('video/img2vid', async () => {
    const { Img2VidPage } = await import('@/features/video/Img2VidPage')
    return <Img2VidPage />
  }),
  { path: 'video/projects', element: <ProjectsPage /> },
  page('video/prompt-templates', async () => {
    const { TemplatesPage } = await import('@/features/templates/TemplatesPage')
    return <TemplatesPage type="video" />
  }),
  // the old name; bookmarks keep working
  { path: 'video/templates', element: <Navigate to="/video/prompt-templates" replace /> },
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
  page('image/img2img', async () => {
    const { Img2ImgPage } = await import('@/features/image/Img2ImgPage')
    return <Img2ImgPage />
  }),
  page('image/references', async () => {
    const { ImageReferencesPage } = await import('@/features/image/ImageReferencesPage')
    return <ImageReferencesPage />
  }),
  page('image/prompt-templates', async () => {
    const { TemplatesPage } = await import('@/features/templates/TemplatesPage')
    return <TemplatesPage type="image" />
  }),
  // the old name; bookmarks keep working
  { path: 'image/templates', element: <Navigate to="/image/prompt-templates" replace /> },
  page('image/upscale', async () => {
    const { UpscalePickPage } = await import('@/features/upscale/UpscalePickPage')
    return <UpscalePickPage kind="image" />
  }),
  page('image/studio', async () => {
    const { PhotoStudioPickPage } = await import('@/features/photo/PhotoStudioPickPage')
    return <PhotoStudioPickPage />
  }),
  page('image/studio/:generationId', async () => {
    const { PhotoStudioPage } = await import('@/features/photo/PhotoStudioPage')
    return <PhotoStudioPage />
  }),
  page('photos', async () => {
    const { PhotosPage } = await import('@/features/photos/PhotosPage')
    return <PhotosPage />
  }),
  page('image/library', async () => {
    const { LibraryPage } = await import('@/features/library/LibraryPage')
    return <LibraryPage kind="image" />
  }),
  // Audio: one workspace frame (sidebar, status strip, transport) around every page (contract v14, v15, v16)
  {
    path: 'audio',
    lazy: async () => ({ Component: (await import('@/features/audio/shell/AudioWorkspace')).AudioWorkspace }),
    children: [
      { index: true, element: <Navigate to="/audio/song" replace /> },
      page('song', async () => {
        const { SongPage } = await import('@/features/audio/SongPage')
        return <SongPage />
      }),
      page('music', async () => {
        const { MusicPage } = await import('@/features/audio/MusicPage')
        return <MusicPage />
      }),
      page('sfx', async () => {
        const { SfxPage } = await import('@/features/audio/SfxPage')
        return <SfxPage />
      }),
      page('speak', async () => {
        const { SpeakPage } = await import('@/features/audio/voice/SpeakPage')
        return <SpeakPage />
      }),
      page('voices', async () => {
        const { VoicesPage } = await import('@/features/audio/voice/VoicesPage')
        return <VoicesPage />
      }),
      page('gallery', async () => {
        const { GalleryPage } = await import('@/features/audio/voice/GalleryPage')
        return <GalleryPage />
      }),
      page('design', async () => {
        const { DesignPage } = await import('@/features/audio/voice/DesignPage')
        return <DesignPage />
      }),
      page('dialogue', async () => {
        const { DialogueListPage } = await import('@/features/audio/dialogue/DialogueListPage')
        return <DialogueListPage />
      }),
      page('dialogue/:id', async () => {
        const { DialogueEditorPage } = await import('@/features/audio/dialogue/DialogueEditorPage')
        return <DialogueEditorPage />
      }),
      page('podcast', async () => {
        const { PodcastListPage } = await import('@/features/audio/podcast/PodcastListPage')
        return <PodcastListPage />
      }),
      page('podcast/:id', async () => {
        const { EpisodePage } = await import('@/features/audio/podcast/EpisodePage')
        return <EpisodePage />
      }),
      page('edit', async () => {
        const { EditPickPage } = await import('@/features/audio/editor/EditPickPage')
        return <EditPickPage />
      }),
      page('edit/:id', async () => {
        const { EditorPage } = await import('@/features/audio/editor/EditorPage')
        return <EditorPage />
      }),
      page('score', async () => {
        const { ScorePage } = await import('@/features/audio/score/ScorePage')
        return <ScorePage />
      }),
      // contract v18
      page('transcribe', async () => {
        const { TranscribePage } = await import('@/features/audio/transcribe/TranscribePage')
        return <TranscribePage />
      }),
      // contract v21
      page('stems', async () => {
        const { StemsPage } = await import('@/features/audio/stems/StemsPage')
        return <StemsPage />
      }),
      page('dub', async () => {
        const { DubListPage } = await import('@/features/audio/dub/DubListPage')
        return <DubListPage />
      }),
      page('dub/:id', async () => {
        const { DubWorkspacePage } = await import('@/features/audio/dub/DubWorkspacePage')
        return <DubWorkspacePage />
      }),
      page('prompt-templates', async () => {
        const { TemplatesPage } = await import('@/features/templates/TemplatesPage')
        return <TemplatesPage type="audio" />
      }),
      page('library', async () => {
        const { LibraryPage } = await import('@/features/library/LibraryPage')
        return <LibraryPage kind="audio" />
      }),
    ],
  },

  { path: 'image', element: <Navigate to="/image/generate" replace /> },
  { path: 'video', element: <Navigate to="/video/quick" replace /> },

  page('assets', async () => {
    const { AssetsPage } = await import('@/features/assets/AssetsPage')
    return <AssetsPage />
  }),
  page('brand-kits', async () => {
    const { BrandKitsPage } = await import('@/features/brand/BrandKitsPage')
    return <BrandKitsPage />
  }),
  page('brand-kits/:kitId', async () => {
    const { BrandKitEditorPage } = await import('@/features/brand/BrandKitEditorPage')
    return <BrandKitEditorPage />
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
