export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface SaveFileOptions {
  suggestedName: string
  filters?: FileDialogFilter[]
  mime?: string
}

export interface OpenTextFileOptions {
  filters?: FileDialogFilter[]
}

export interface OpenTextFileResult {
  name: string
  text: string
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && (
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window
  )
}

export async function saveBytes(data: Uint8Array, options: SaveFileOptions): Promise<boolean> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const target = await save({
      defaultPath: options.suggestedName,
      filters: options.filters,
    })

    if (!target || Array.isArray(target)) return false
    await writeFile(target, data)
    return true
  }

  const blob = new Blob([toArrayBuffer(data)], { type: options.mime ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = options.suggestedName
  a.click()
  URL.revokeObjectURL(url)
  return true
}

export async function saveText(text: string, options: SaveFileOptions): Promise<boolean> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    const target = await save({
      defaultPath: options.suggestedName,
      filters: options.filters,
    })

    if (!target || Array.isArray(target)) return false
    await writeTextFile(target, text)
    return true
  }

  const blob = new Blob([text], { type: options.mime ?? 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = options.suggestedName
  a.click()
  URL.revokeObjectURL(url)
  return true
}

export async function openTextFile(options: OpenTextFileOptions = {}): Promise<OpenTextFileResult | null> {
  if (isTauriRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const target = await open({
      multiple: false,
      directory: false,
      filters: options.filters,
    })

    if (!target || Array.isArray(target)) return null
    const text = await readTextFile(target)
    const parts = target.replace(/\\/g, '/').split('/')
    return {
      name: parts[parts.length - 1] || 'file.txt',
      text,
    }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = toAcceptString(options.filters)
    input.id = 'platform-open-text-file'
    input.name = 'platform-open-text-file'

    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }

      try {
        resolve({
          name: file.name,
          text: await file.text(),
        })
      } catch (error) {
        reject(error)
      }
    })

    input.click()
  })
}

function toAcceptString(filters?: FileDialogFilter[]): string {
  if (!filters || filters.length === 0) return ''
  return filters.flatMap(filter => filter.extensions.map(ext => `.${ext}`)).join(',')
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}


