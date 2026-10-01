// @vitest-environment jsdom
/**
 * ReferenceChip visual face: icon selection per appearance, the trigger
 * marker fallback, label truncation container, and invalid styling.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReferenceChip } from '../src/client/input/editor/ReferenceChip.tsx'

afterEach(cleanup)

describe('ReferenceChip', () => {
  it('renders the domain icon and the label', () => {
    const { container, getByTitle } = render(
      <ReferenceChip label="Research notes" appearance="session" invalid={false} />,
    )
    expect(getByTitle('Research notes')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toBe('Research notes')
  })

  it('falls back to the trigger marker without an appearance', () => {
    const { container } = render(<ReferenceChip label="commit-helper" invalid={false} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('@commit-helper')
  })

  it('applies the invalid styling bit', () => {
    const { container } = render(<ReferenceChip label="gone" appearance="folder" invalid />)
    const chip = container.firstElementChild
    expect(chip).not.toBeNull()
    expect([...(chip?.classList ?? [])].some(name => name.includes('invalid'))).toBe(true)
  })

  it('shows the referenced picture itself when the owner supplies a preview', () => {
    const { container, getByTitle } = render(
      <ReferenceChip
        label="角色身份板"
        appearance="image"
        thumbnailUrl="https://oss.example.com/a.png"
        invalid={false}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://oss.example.com/a.png')
    // 预览取代字形图标：一个引用只表达一个身份。
    expect(container.querySelector('svg')).toBeNull()
    expect(getByTitle('角色身份板').textContent).toBe('角色身份板')
  })

  it('falls back to the domain glyph when the preview fails to load', () => {
    const { container } = render(
      <ReferenceChip
        label="角色身份板"
        appearance="image"
        thumbnailUrl="https://blocked.example.com/a.png"
        invalid={false}
      />,
    )
    fireEvent.error(container.querySelector('img')!)
    // 取不到画面时退回字形：不能让用户对着一张可能没加载出来的破图以为引用成功。
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
