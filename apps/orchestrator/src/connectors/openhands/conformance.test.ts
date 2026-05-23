import { runProviderAdapterConformance } from '@agent-canvas/connector-core/conformance'
import { OpenHandsProvider } from './provider.js'

runProviderAdapterConformance(new OpenHandsProvider())
