import { describe, expect, it } from 'vitest'
import {
  constrainImageModelCatalogConfigByPricing,
  parseImageModelCatalogConfig,
} from './modelCatalogMeta'

describe('图片模型目录配置', () => {
  it('解析 meta.imageOptions.maxReferenceImages 作为模型级参考图上限', () => {
    const config = parseImageModelCatalogConfig({
      imageOptions: {
        supportsTextToImage: true,
        supportsImageToImage: true,
        supportsReferenceImages: true,
        maxReferenceImages: 16,
        aspectRatioOptions: ['16:9'],
      },
    })
    expect(config?.maxReferenceImages).toBe(16)
    expect(config?.supportsImageToImage).toBe(true)
  })

  it('未声明 maxReferenceImages 时不产生模型级上限', () => {
    const config = parseImageModelCatalogConfig({
      imageOptions: { supportsTextToImage: true, aspectRatioOptions: ['16:9'] },
    })
    expect(config?.maxReferenceImages).toBeUndefined()
  })

  it('只有 maxReferenceImages 的配置也会被解析出来', () => {
    const config = parseImageModelCatalogConfig({ imageOptions: { maxReferenceImages: 4 } })
    expect(config?.maxReferenceImages).toBe(4)
  })

  it('价格约束不丢弃模型级参考图上限', () => {
    const config = parseImageModelCatalogConfig({
      imageOptions: {
        maxReferenceImages: 16,
        aspectRatioOptions: ['16:9', '1:1'],
      },
    })
    const constrained = constrainImageModelCatalogConfigByPricing(config, {
      cost: 0,
      enabled: true,
      specCosts: [{ specKey: 'image:16:9:1k', cost: 0, enabled: true }],
    })
    expect(constrained?.maxReferenceImages).toBe(16)
  })
})
