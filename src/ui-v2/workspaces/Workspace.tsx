import type { WorkspaceId } from './catalog'
import type { WorkspaceProps } from './shared'
import { Home } from './Home'
import { Chat } from './Chat'
import { Mind } from './Mind'
import { Mission } from './Mission'
import { Forge } from './Forge'
import { World } from './World'
import { Life } from './Life'
import { Relay } from './Relay'
import { Workforce } from './Workforce'
import { Widgets } from './Widgets'
import { BrainCore } from './BrainCore'
import { Settings } from './Settings'
export function Workspace({ id, open, panels, ...props }: WorkspaceProps & { id: WorkspaceId; open: (id: WorkspaceId) => void; panels: readonly string[] }) {
  switch (id) {
    case 'home': return <Home {...props} open={open} panels={panels} />
    case 'chat': return <Chat />
    case 'mind': return <Mind {...props} />
    case 'mission': return <Mission {...props} />
    case 'forge': return <Forge {...props} />
    case 'world': return <World {...props} />
    case 'life': return <Life {...props} />
    case 'relay': return <Relay {...props} />
    case 'workforce': return <Workforce {...props} />
    case 'widgets': return <Widgets open={open} />
    case 'brain-core': return <BrainCore {...props} />
    case 'settings': return <Settings {...props} />
  }
}
