export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'vol3d_theme'

export function getTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

// Persist + apply the opposite theme; returns the newly-active theme.
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // ignore persistence failure (e.g. private mode); still apply for this session
  }
  applyTheme(next)
  return next
}
