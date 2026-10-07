import { QuickCreateForm } from './QuickCreateForm'
import { RecentQuick } from './RecentQuick'

export function QuickCreatePage() {
  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Quick Create">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 md:px-8">
        <QuickCreateForm expanded />
        <RecentQuick />
      </div>
    </main>
  )
}
