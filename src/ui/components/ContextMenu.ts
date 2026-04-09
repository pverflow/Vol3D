export interface MenuItem {
  label: string
  icon?: string
  action: () => void
  danger?: boolean
  separator?: boolean
}

let activeMenu: HTMLElement | null = null

export function showContextMenu(items: MenuItem[], x: number, y: number) {
  // Remove existing menu
  if (activeMenu) activeMenu.remove()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div')
      sep.className = 'context-sep'
      menu.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'context-item' + (item.danger ? ' danger' : '')
    if (item.icon) {
      const icon = document.createElement('span')
      icon.className = 'context-icon'
      icon.textContent = item.icon
      btn.appendChild(icon)
    }
    btn.appendChild(document.createTextNode(item.label))
    btn.addEventListener('click', () => {
      item.action()
      menu.remove()
      activeMenu = null
    })
    menu.appendChild(btn)
  }

  document.body.appendChild(menu)
  activeMenu = menu

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`

  // Close on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove()
        activeMenu = null
        document.removeEventListener('mousedown', close)
      }
    }
    document.addEventListener('mousedown', close)
  }, 10)
}
