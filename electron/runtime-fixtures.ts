export function e2eKey(variable: string): Uint8Array | null {
  if (process.env.FREYA_E2E !== '1') return null
  const encoded = process.env[variable]
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 32) throw new Error(`${variable} must decode to 32 bytes`)
  return new Uint8Array(bytes)
}

/**
 * Both test keys, or neither.
 *
 * One without the other would produce a restart-persistence E2E where the
 * conversation survives and the Brain does not — or the reverse — and the failure
 * would look like a Brain bug rather than a harness that only half injected.
 */
export function e2eKeys(): {
  conversation: Uint8Array
  brain: Uint8Array
  mission: Uint8Array
  context: Uint8Array
  personality: Uint8Array
  skill: Uint8Array
  forge: Uint8Array
  vault: Uint8Array
  attention: Uint8Array
} | null {
  const conversation = e2eKey('FREYA_E2E_CONVERSATION_KEY')
  const brain = e2eKey('FREYA_E2E_BRAIN_KEY')
  const mission = e2eKey('FREYA_E2E_MISSION_KEY')
  const context = e2eKey('FREYA_E2E_CONTEXT_KEY')
  const skill = e2eKey('FREYA_E2E_SKILL_KEY')
  const forge = e2eKey('FREYA_E2E_FORGE_KEY')
  const personality = e2eKey('FREYA_E2E_PERSONALITY_KEY')
  const vault = e2eKey('FREYA_E2E_VAULT_KEY')
  // All seven or none, so a partial fixture cannot quietly run with a real keyring for
  // the domain it forgot.
  if (
    conversation === null ||
    brain === null ||
    mission === null ||
    context === null ||
    personality === null ||
    skill === null ||
    forge === null ||
    vault === null
  ) {
    return null
  }
  const attention = e2eKey('FREYA_E2E_ATTENTION_KEY') ?? new Uint8Array(32).fill(9)
  return { conversation, brain, mission, context, personality, skill, forge, vault, attention }
}
