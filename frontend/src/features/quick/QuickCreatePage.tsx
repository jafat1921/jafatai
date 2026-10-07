import { useLocation, useSearchParams } from 'react-router'
import { quickFormFrom, type TemplatePrefill } from '@/lib/templates'
import { QuickCreateForm } from './QuickCreateForm'
import { RecentQuick } from './RecentQuick'

export function QuickCreatePage() {
  const location = useLocation()
  const [params] = useSearchParams()
  const tpl = (location.state as { template?: TemplatePrefill } | null)?.template
  const prompt = params.get('prompt')
  const initial = tpl ? quickFormFrom(tpl.prefill) : prompt ? { prompt } : undefined

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Quick Create">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 md:px-8">
        <QuickCreateForm
          key={location.key}
          expanded
          initial={initial}
          note={
            tpl && (
              <p className="self-start rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">
                Template: {tpl.templateTitle}
              </p>
            )
          }
        />
        <RecentQuick />
      </div>
    </main>
  )
}
