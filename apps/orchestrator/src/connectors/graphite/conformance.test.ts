import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
import { GraphiteConnector } from './connector.js'

runConnectorConformance(new GraphiteConnector())
