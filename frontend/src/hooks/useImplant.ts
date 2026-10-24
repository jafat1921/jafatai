import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMe } from '@/hooks/useAuth'
import { implantApi, implantBusy, type Garment, type ImplantOption, type Patient, type PatientCreate, type PatientPatch, type View } from '@/lib/implant'

const POLL_MS = 3000
const LIST = ['implant', 'list'] as const

export const patientKey = (id: string) => ['implant', id] as const

export function usePatients() {
  const { data: me } = useMe()
  return useQuery({ queryKey: LIST, queryFn: implantApi.list, enabled: !!(me?.admin || me?.implant) })
}

export function usePatient(id: string | undefined) {
  return useQuery({
    queryKey: patientKey(id ?? ''),
    queryFn: () => implantApi.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (implantBusy(q.state.data) ? POLL_MS : false),
  })
}

function put(qc: QueryClient, p: Patient) {
  qc.setQueryData(patientKey(p.id), p)
  void qc.invalidateQueries({ queryKey: LIST })
}

export function useCreatePatient() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: PatientCreate) => implantApi.create(body), onSuccess: (p) => put(qc, p) })
}

export function usePatchPatient(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: PatientPatch) => implantApi.patch(id, body), onSuccess: (p) => put(qc, p) })
}

export function useDeletePatient(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => implantApi.remove(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: patientKey(id) })
      void qc.invalidateQueries({ queryKey: LIST })
    },
  })
}

export function useConsentForm(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (file: File) => implantApi.consentForm(id, file), onSuccess: (p) => put(qc, p) })
}

export function useUploadPhoto(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { file: File; view: View; garment: Garment; crop?: string }) => implantApi.photo(id, body),
    // the answer is only the photo, so fetch the patient again for the slot
    onSuccess: () => qc.invalidateQueries({ queryKey: patientKey(id) }),
  })
}

export function useRenderOptions(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (options: ImplantOption[]) => implantApi.render(id, options), onSuccess: (p) => put(qc, p) })
}

export function useApproveOption(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, ...body }: { sessionId: string; option: number; notes: string }) => implantApi.approve(id, sessionId, body),
    onSuccess: (p) => put(qc, p),
  })
}

export function useRetryPicture(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (jobId: string) => implantApi.retry(jobId), onSuccess: () => qc.invalidateQueries({ queryKey: patientKey(id) }) })
}
