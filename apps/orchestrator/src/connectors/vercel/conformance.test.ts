import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { VercelConnector } from './connector.js'

runConnectorConformance(new VercelConnector())
