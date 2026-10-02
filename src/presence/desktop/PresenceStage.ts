import * as THREE from 'three'
import type { PresenceFrame, PresenceAnimation, PresenceProtocolState } from '../../../core/presence/protocol'

/**
 * The presence stage: a Three.js renderer for the presence window.
 *
 * This is the **replaceable** presentation layer. It draws a bounded
 * animation for each presence frame and nothing else. It holds no Core state,
 * makes no model calls, and decides nothing.
 *
 * ## Replaceability
 *
 * A future Godot or native renderer replaces this file by implementing the
 * same `PresenceStage` interface. The protocol (`core/presence/protocol.ts`)
 * is the contract: any renderer that can draw a `PresenceFrame` can be a
 * presence renderer.
 *
 * ## Bounded animation vocabulary
 *
 * Each presence state maps to exactly one animation, fixed by the protocol.
 * The stage does not choose animations; it receives them in the frame.
 *
 * ## What it does not do
 *
 * - It does not decide presence state.
 * - It does not invent animations.
 * - It does not claim emotional or mental states.
 * - It does not make model calls.
 * - It does not hold Core state beyond the current frame.
 */

export interface PresenceStageOptions {
  readonly canvas: HTMLCanvasElement
  readonly onReady?: () => void
}

/**
 * The presence stage interface.
 *
 * Any renderer that implements this interface can be a presence renderer.
 * The interface is deliberately small: one method to receive a frame, one to
 * resize, one to dispose.
 */
export interface PresenceStageInterface {
  renderFrame(frame: PresenceFrame): void
  resize(width: number, height: number): void
  dispose(): void
}

/**
 * The Three.js presence stage.
 *
 * One scene, one camera, one orb. The orb's animation is driven by the
 * presence frame's animation name. The orb's color is driven by the presence
 * state. Nothing else moves.
 */
export class PresenceStage implements PresenceStageInterface {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly orb: THREE.Mesh
  private readonly glow: THREE.Mesh
  private raf = 0
  private running = false
  private disposed = false
  private clock = new THREE.Clock()
  private elapsed = 0

  private currentAnimation: PresenceAnimation = 'breathe'
  private targetColor = new THREE.Color('#4a9eff')
  private currentColor = new THREE.Color('#4a9eff')

  constructor(options: PresenceStageOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      alpha: true,
      antialias: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(240, 240, false)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 0, 4)

    // The orb: a simple sphere with a shader that pulses.
    const geometry = new THREE.SphereGeometry(1, 32, 32)
    const material = new THREE.MeshStandardMaterial({
      color: this.currentColor,
      emissive: this.currentColor,
      emissiveIntensity: 0.3,
      roughness: 0.4,
      metalness: 0.1,
    })
    this.orb = new THREE.Mesh(geometry, material)
    this.scene.add(this.orb)

    // The glow: a larger, transparent sphere that creates a halo effect.
    const glowGeometry = new THREE.SphereGeometry(1.3, 32, 32)
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: this.currentColor,
      transparent: true,
      opacity: 0.15,
    })
    this.glow = new THREE.Mesh(glowGeometry, glowMaterial)
    this.scene.add(this.glow)

    // Lighting.
    const ambient = new THREE.AmbientLight(0xffffff, 0.5)
    this.scene.add(ambient)
    const directional = new THREE.DirectionalLight(0xffffff, 1)
    directional.position.set(2, 3, 4)
    this.scene.add(directional)

    this.running = true
    this.animate()

    // Defer the ready callback so the stage is fully initialized before
    // the component tries to use it.
    setTimeout(() => options.onReady?.(), 0)
  }

  /**
   * Render a presence frame.
   *
   * The frame is already validated by the protocol. The stage draws it and
   * nothing else.
   */
  renderFrame(frame: PresenceFrame): void {
    this.currentAnimation = frame.animation
    this.targetColor = new THREE.Color(this.colorForState(frame.state))
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    this.disposed = true
    this.running = false
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }

  private animate = (): void => {
    if (!this.running || this.disposed) return
    this.raf = requestAnimationFrame(this.animate)

    const delta = this.clock.getDelta()
    this.elapsed += delta

    // Smooth color transition.
    this.currentColor.lerp(this.targetColor, 0.05)
    const material = this.orb.material as THREE.MeshStandardMaterial
    material.color.copy(this.currentColor)
    material.emissive.copy(this.currentColor)
    const glowMaterial = this.glow.material as THREE.MeshBasicMaterial
    glowMaterial.color.copy(this.currentColor)

    // Animate based on the current animation.
    this.applyAnimation(this.currentAnimation, delta)

    this.renderer.render(this.scene, this.camera)
  }

  private applyAnimation(animation: PresenceAnimation, delta: number): void {
    const t = this.elapsed
    switch (animation) {
      case 'breathe': {
        const scale = 1 + Math.sin(t * 1.5) * 0.05
        this.orb.scale.setScalar(scale)
        this.glow.scale.setScalar(scale * 1.1)
        break
      }
      case 'pulse': {
        const scale = 1 + Math.sin(t * 4) * 0.08
        this.orb.scale.setScalar(scale)
        this.glow.scale.setScalar(scale * 1.15)
        break
      }
      case 'spin': {
        this.orb.rotation.y += delta * 2
        this.glow.rotation.y += delta * 2
        break
      }
      case 'wave': {
        const scale = 1 + Math.sin(t * 8) * 0.1
        this.orb.scale.set(scale, 1 + Math.sin(t * 8 + 1) * 0.1, scale)
        this.glow.scale.setScalar(1.1)
        break
      }
      case 'glow': {
        const intensity = 0.3 + Math.sin(t * 3) * 0.2
        const material = this.orb.material as THREE.MeshStandardMaterial
        material.emissiveIntensity = intensity
        this.glow.scale.setScalar(1.2)
        break
      }
      case 'alert': {
        const scale = 1 + Math.sin(t * 6) * 0.06
        this.orb.scale.setScalar(scale)
        this.glow.scale.setScalar(scale * 1.2)
        break
      }
      case 'dim': {
        const material = this.orb.material as THREE.MeshStandardMaterial
        material.emissiveIntensity = 0.1
        this.orb.scale.setScalar(0.95)
        this.glow.scale.setScalar(1.0)
        break
      }
    }
  }

  private colorForState(state: PresenceProtocolState): string {
    switch (state) {
      case 'idle':
        return '#4a9eff'
      case 'listening':
        return '#34d399'
      case 'thinking':
        return '#818cf8'
      case 'speaking':
        return '#f472b6'
      case 'working':
        return '#fbbf24'
      case 'attention':
        return '#fb923c'
      case 'error':
        return '#ef4444'
      case 'degraded':
        return '#9ca3af'
    }
  }
}
