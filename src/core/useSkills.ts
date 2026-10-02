import { useEffect, useState } from 'react'
import { skillsMirror } from '../platform/skillsClient'
import type { SkillProjection } from '../../core/protocol/skills'

/**
 * The Skills projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work and the rest, because they
 * answer different questions about the same moment: what was said, what Freya knows,
 * what she is executing — and, here, what procedures she has recorded, what evidence
 * stands behind each one, and how far through verification it got.
 *
 * Read-only in the stronger sense that matters: a component cannot set a status, assert
 * a verdict, submit a verification record, move a threshold or write a skill body by
 * writing to something it received, because the projection has no writable field for
 * any of those and the mirror has no method that sends them. Everything a surface shows
 * is what Core pushed, and the *ordering* it shows is Core's ordering too.
 */
export function useSkills(): SkillProjection | null {
  const [projection, setProjection] = useState<SkillProjection | null>(null)
  const mirror = skillsMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}