import { useCatalog } from '@/hooks/useModels'
import { menusFrom } from '@/lib/nav'

/** Mega-menu sections with their Models column filled from the live catalog. */
export const useMenus = () => menusFrom(useCatalog())
