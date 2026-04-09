import { uid } from '../../utils/uid'

export interface SelectOption {
  value: string
  label: string
  color?: string
}

export class Select {
  readonly el: HTMLSelectElement
  private readonly fieldId: string

  constructor(
    options: SelectOption[],
    value: string,
    onChange: (value: string) => void
  ) {
    this.fieldId = `select-${uid()}`
    this.el = document.createElement('select')
    this.el.className = 'ui-select'
    this.el.id = this.fieldId
    this.el.name = this.fieldId

    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.label
      this.el.appendChild(o)
    }
    this.el.value = value

    this.el.addEventListener('change', () => onChange(this.el.value))
  }

  setValue(v: string) { this.el.value = v }
  get value(): string { return this.el.value }
}
