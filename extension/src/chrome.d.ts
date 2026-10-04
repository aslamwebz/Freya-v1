/**
 * A minimal ambient `chrome` declaration.
 *
 * Only the surface this extension uses is declared, so a call to a capability that was
 * never requested (`cookies`, `history`, `downloads`, `webRequest`, `nativeMessaging`)
 * fails to type-check rather than silently existing. `@types/chrome` would declare all
 * of them, and the point here is the opposite.
 */

export {}

declare global {
  namespace chrome {
    namespace runtime {
      const id: string
      function getManifest(): { readonly version: string }
      interface MessageSender {
        readonly tab?: tabs.Tab
      }
      interface OnMessage {
        addListener(
          listener: (
            message: unknown,
            sender: MessageSender,
            sendResponse: (response?: unknown) => void,
          ) => boolean | void,
        ): void
      }
      const onMessage: OnMessage
      function sendMessage(message: unknown): Promise<unknown>
    }

    namespace storage {
      namespace local {
        function get(keys: string | string[] | null): Promise<Record<string, unknown>>
        function set(items: Record<string, unknown>): Promise<void>
        function remove(keys: string | string[]): Promise<void>
      }
    }

    namespace tabs {
      interface Tab {
        readonly id?: number
        readonly windowId?: number
        readonly url?: string
        readonly title?: string
        readonly active?: boolean
        readonly status?: string
      }
      interface UpdateProperties {
        url?: string
        active?: boolean
      }
      function get(tabId: number): Promise<Tab>
      function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>
      function update(tabId: number, properties: UpdateProperties): Promise<Tab>
      interface OnRemoved {
        addListener(listener: (tabId: number) => void): void
      }
      interface OnUpdated {
        addListener(listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void): void
      }
      const onRemoved: OnRemoved
      const onUpdated: OnUpdated
    }

    namespace scripting {
      interface InjectionTarget {
        tabId: number
        frameIds?: number[]
      }
      interface Injection<A extends unknown[], R> {
        target: InjectionTarget
        func: (...args: A) => R
        args?: A
      }
      interface InjectionResult<R> {
        readonly result: R
        readonly frameId: number
      }
      function executeScript<A extends unknown[], R>(
        injection: Injection<A, R>,
      ): Promise<Array<InjectionResult<R>>>
    }
  }
}
