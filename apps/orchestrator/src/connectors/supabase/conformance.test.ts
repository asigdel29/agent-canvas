import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { SupabaseConnector } from './connector.js'

runConnectorConformance(new SupabaseConnector())
