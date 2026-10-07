import { describe, expect, it } from 'vitest'

import { initialToolRequestForOwnerText } from '../../../core/mind/tool-intent'

describe('Core-owned initial Chat tool requests', () => {
  it('seeds image requests into the images vertical', () => {
    expect(initialToolRequestForOwnerText('show me images of the James Webb telescope')).toEqual({
      name: 'web_search',
      arguments: { query: 'show me images of the James Webb telescope', type: 'images' },
    })
  })

  it('seeds video requests into the videos vertical', () => {
    expect(initialToolRequestForOwnerText('find 5 videos about Laravel queues')).toEqual({
      name: 'web_search',
      arguments: { query: 'find 5 videos about Laravel queues', type: 'videos' },
    })
  })

  it('seeds PDF and document requests into the documents vertical', () => {
    expect(initialToolRequestForOwnerText('find the official PDF for the EU AI Act')).toEqual({
      name: 'web_search',
      arguments: { query: 'find the official PDF for the EU AI Act', type: 'documents' },
    })
  })

  it('does not turn explanations about media into searches', () => {
    expect(initialToolRequestForOwnerText('explain how video compression works')).toBeNull()
    expect(initialToolRequestForOwnerText('what is a PDF?')).toBeNull()
  })

  it('keeps explicit browser control stronger than media search', () => {
    expect(initialToolRequestForOwnerText(
      'Use your own browser to open https://example.com and find images there',
    )).toEqual({
      name: 'browser_read',
      arguments: { url: 'https://example.com/' },
    })
  })
})


describe('arbitrary intent-aware retrieval', () => {
  it('separates an audio vertical and arbitrary domain from exact owner text', () => {
    const text = '  find podcasts about climate on example.org  '
    expect(initialToolRequestForOwnerText(text)).toEqual({ name: 'web_search', arguments: { query: text, type: 'audio', site: 'example.org' } })
  })
  it('does not assume a named video platform means a video request', () => {
    expect(initialToolRequestForOwnerText('find articles from youtube.com')).toMatchObject({ arguments: { type: 'web', site: 'youtube.com' } })
  })
  it('seeds a general browser discovery before the model chooses a real result URL', () => {
    expect(initialToolRequestForOwnerText('use your browser to find jazz concerts')).toMatchObject({ name: 'web_search', arguments: { type: 'web' } })
  })
})
