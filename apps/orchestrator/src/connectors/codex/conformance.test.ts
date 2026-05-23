import { runProviderAdapterConformance } from '@agent-canvas/connector-core/conformance'
import { CodexProvider } from './provider.js'

runProviderAdapterConformance(new CodexProvider())
