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
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeFile } = await import('@tauri-apps/plugin-fs')
      const target = await save({
        defaultPath: options.suggestedName,
        filters: options.filters,
      })

      if (!target || Array.isArray(target)) return false
      await writeFile(target, data)
      return true
    } catch (error) {
      throw new Error(`Desktop file save failed: ${describePlatformError(error)}`)
    }
  }

  const blob = new Blob([toArrayBuffer(data)], { type: options.mime ?? 'application/octet-stream' })
  triggerBrowserDownload(blob, options.suggestedName)
  return true
}

export async function saveText(text: string, options: SaveFileOptions): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const target = await save({
        defaultPath: options.suggestedName,
        filters: options.filters,
      })

      if (!target || Array.isArray(target)) return false
      await writeTextFile(target, text)
      return true
    } catch (error) {
      throw new Error(`Desktop text save failed: ${describePlatformError(error)}`)
    }
  }

  const blob = new Blob([text], { type: options.mime ?? 'text/plain;charset=utf-8' })
  triggerBrowserDownload(blob, options.suggestedName)
  return true
}

export async function openTextFile(options: OpenTextFileOptions = {}): Promise<OpenTextFileResult | null> {
  if (isTauriRuntime()) {
    try {
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
    } catch (error) {
      throw new Error(`Desktop file open failed: ${describePlatformError(error)}`)
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

function triggerBrowserDownload(blob: Blob, suggestedName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = suggestedName
  anchor.style.display = 'none'

  document.body.appendChild(anchor)
  anchor.click()

  window.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}

function describePlatformError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error

  try {
    const json = JSON.stringify(error)
    if (json && json !== '{}') return json
  } catch {
    // ignore JSON conversion failures
  }

  return String(error)
}



