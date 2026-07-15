import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
describe('core determinism', () => {
  it('no Date.now / Math.random anywhere in src', () => {
    const files = readdirSync('packages/block-core/src').filter((f) => f.endsWith('.ts'))
    for (const f of files) {
      const text = readFileSync(`packages/block-core/src/${f}`, 'utf8')
      expect(text, f).not.toMatch(/Date\.now|Math\.random/)
    }
  })
})
