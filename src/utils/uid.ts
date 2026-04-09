let counter = 0
export function uid(): string {
  return `${Date.now().toString(36)}-${(++counter).toString(36)}`
}
