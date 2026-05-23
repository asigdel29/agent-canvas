import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { LinearConnector } from './connector.js'

runConnectorConformance(new LinearConnector())
