import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { GeneratorPage } from '@/components/generate/GeneratorPage'
import { quickFormFrom, type TemplatePrefill } from '@/lib/templates'
import { QuickCreateForm } from './QuickCreateForm'
import { RecentQuick } from './RecentQuick'

export function QuickCreatePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const tpl = (location.state as { template?: TemplatePrefill } | null)?.template
  const prompt = params.get('prompt')
  const initial = tpl ? quickFormFrom(tpl.prefill) : prompt ? { prompt } : undefined

  return (
    <GeneratorPage
      label="Quick Create"
      // a film starts from words; a picture is better used by the clip tools
      targets={[
        { id: 'start', label: 'Start frame', hint: 'Opens Image to Video with this picture', use: (m) => navigate(`/video/img2vid?image=${m.id}`) },
        { id: 'edit', label: 'Edit source', hint: 'Opens Edit Image with this picture', use: (m) => navigate(`/image/edit?sources=${m.id}`) },
      ]}
    >
      <QuickCreateForm
        key={location.key}
        expanded
        initial={initial}
        note={tpl && <p className="rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">Template: {tpl.templateTitle}</p>}
      />
      <RecentQuick />
    </GeneratorPage>
  )
}
