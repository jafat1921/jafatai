import { useState } from 'react'
import { FolderOpen, ListTree, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { LibraryPanel } from './LibraryPanel'
import { ScenesPanel } from './ScenesPanel'
import { useAddScene } from './useAddScene'

// 1280–1439 px: the Scenes column folds into the Library as a second tab (design-system §2).
export function LibraryWithScenes() {
  const [tab, setTab] = useState('scenes')
  const { add, pending } = useAddScene()
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-studio-border px-2 py-1.5">
        <TabsList aria-label="Library or scenes">
          <TabsTrigger value="scenes">
            <ListTree aria-hidden />
            Scenes
          </TabsTrigger>
          <TabsTrigger value="library">
            <FolderOpen aria-hidden />
            Assets
          </TabsTrigger>
        </TabsList>
        {tab === 'scenes' && (
          <Tooltip content="Add scene">
            <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={add} loading={pending} aria-label="Add scene">
              <Plus aria-hidden />
            </Button>
          </Tooltip>
        )}
      </div>
      <TabsContent value="scenes" className="min-h-0 flex-1">
        <ScenesPanel />
      </TabsContent>
      <TabsContent value="library" className="min-h-0 flex-1">
        <LibraryPanel />
      </TabsContent>
    </Tabs>
  )
}
