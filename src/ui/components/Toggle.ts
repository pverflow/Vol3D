import { uid } from '../../utils/uid'

export class Toggle {
  readonly el: HTMLElement
  private checkbox: HTMLInputElement

  constructor(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void
  ) {
    this.el = document.createElement('label')
    this.el.className = 'ui-toggle'

    this.checkbox = document.createElement('input')
    const fieldId = `toggle-${uid()}`
    this.checkbox.type = 'checkbox'
    this.checkbox.id = fieldId
    this.checkbox.name = fieldId
    this.checkbox.checked = checked

    const track = document.createElement('span')
    track.className = 'toggle-track'
    const knob = document.createElement('span')
    knob.className = 'toggle-knob'
    track.appendChild(knob)

    const text = document.createElement('span')
    text.className = 'toggle-label'
    text.textContent = label

    this.el.appendChild(this.checkbox)
    this.el.appendChild(track)
    this.el.appendChild(text)

    this.checkbox.addEventListener('change', () => onChange(this.checkbox.checked))
  }

  setValue(v: boolean) { this.checkbox.checked = v }
  get value(): boolean { return this.checkbox.checked }
}
