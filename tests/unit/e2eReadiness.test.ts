import { afterEach, describe, expect, it } from 'vitest'
import { appReady, vaultSettled } from '../e2e/readiness'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Electron E2E readiness', () => {
  it('accepts explicit shell and Core readiness with a zero-sized root and Presence fallback', () => {
    document.body.innerHTML = `<div class="app" data-ready="true" style="display:contents">
      <div class="presence"><p class="presence-fallback">Still frame</p></div>
      <dl><div class="runtime-row"><dt>Core</dt><dd><b>Ready</b></dd></div></dl>
    </div>`
    expect(appReady()).toBe(true)
  })

  it.each(['false', ''])('rejects shell readiness %j even with a ready Core', (ready) => {
    document.body.innerHTML = `<div class="app" data-ready="${ready}"><div class="presence"></div>
      <div class="runtime-row"><dt>Core</dt><dd><b>Ready</b></dd></div></div>`
    expect(appReady()).toBe(false)
  })

  it.each(['Booting', 'Degraded', ''])('rejects Core state %j even with a ready shell', (state) => {
    document.body.innerHTML = `<div class="app" data-ready="true"><div class="presence"></div>
      <div class="runtime-row"><dt>Core</dt><dd><b>${state}</b></dd></div></div>`
    expect(appReady()).toBe(false)
  })

  it('reports a boot error even when the shell claims readiness', () => {
    document.body.innerHTML = '<div class="app" data-ready="true"></div><div class="boot-error">Boot failed</div>'
    expect(() => appReady()).toThrow('Boot failed')
  })
})

describe('Vault projection settling', () => {
  it.each([
    '<p class="vault-absent">Waiting for Core</p>',
    '<div class="vault-surface" data-health="unavailable" data-durable="false"></div>',
  ])('rejects a missing or unavailable Brain projection', (content) => {
    document.body.innerHTML = `<div role="dialog" aria-label="Vault">${content}</div>`
    expect(vaultSettled()).toBe(false)
  })

  it.each(['true', 'false'])('accepts known durability %s without assuming encrypted persistence', (durable) => {
    document.body.innerHTML = `<div role="dialog" aria-label="Vault">
      <div class="vault-surface" data-health="healthy" data-durable="${durable}"></div></div>`
    expect(vaultSettled()).toBe(true)
  })

  it('accepts a degraded Brain as settled so the assertions can expose the fault', () => {
    document.body.innerHTML = `<div role="dialog" aria-label="Vault">
      <div class="vault-surface" data-health="degraded" data-durable="true"></div></div>`
    expect(vaultSettled()).toBe(true)
  })
})
